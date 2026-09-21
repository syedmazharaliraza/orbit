import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { ClaudeSessionState, DiscoveredSession } from '../types'
import { HookEventReducer, type ReducerCheckpoint } from './HookEventReducer'
import { HookInboxReceiver } from './HookInboxReceiver'
import { normalizeCollectorRecord } from './HookNormalizer'
import { ObservationStore } from './ObservationStore'
import { missingRecoveryEvent, recoveryEvent, SessionRecovery, SessionRegistryObserver } from './SessionRecovery'
import type { CollectorRecord, NormalizedHookEvent } from './HookTypes'

type PersistedReducer = ReducerCheckpoint

export class HookObservationService extends EventEmitter {
  private readonly reducer = new HookEventReducer()
  private readonly receiver: HookInboxReceiver
  private readonly store: ObservationStore<PersistedReducer>
  private readonly recovery = new SessionRecovery()
  private readonly registry = new SessionRegistryObserver(this.recovery)
  private sequence = 0
  private processed = new Set<string>()
  private journal: NormalizedHookEvent[] = []
  private journalBytes = 0
  private publishBarrier = true
  private stopped = false
  readonly installationId = randomUUID()
  readonly configRootId: string

  constructor(private readonly observationRoot: string) {
    super()
    this.receiver = new HookInboxReceiver(join(observationRoot, 'inbox'))
    this.store = new ObservationStore(join(observationRoot, 'state'))
    this.configRootId = createHash('sha256').update(process.env.CLAUDE_CONFIG_DIR || 'default').digest('hex').slice(0, 16)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.store.initialize()
    const checkpoint = await this.store.load()
    if (checkpoint) {
      this.sequence = checkpoint.receiverSequence
      this.processed = new Set(checkpoint.processedEventIds)
      this.reducer.restore(checkpoint.reducer)
      const cutoff = Date.now() - 24 * 60 * 60 * 1_000
      this.journal = (checkpoint.events || []).filter((event): event is NormalizedHookEvent => {
        const candidate = event as Partial<NormalizedHookEvent>
        return typeof candidate.eventId === 'string' && typeof candidate.receiverReceivedAt === 'number' && candidate.receiverReceivedAt >= cutoff
      })
      this.journalBytes = this.journal.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0)
    }
    this.receiver.on('record', (record: CollectorRecord, _path: string, done: (error?: Error) => void) => void this.consume(record).then(() => done(), done))
    this.receiver.on('error', error => this.emit('error', error))
    this.receiver.on('invalid-record', () => this.emit('coverage-degraded', new Error('Invalid hook inbox record rejected')))
    await this.receiver.start()

    this.registry.on('session', (session: DiscoveredSession) => void this.apply(recoveryEvent(session, ++this.sequence, 'MetadataChanged', this.configRootId)))
    this.registry.on('removed', (pid: number) => void this.reconcileRemovedPid(pid))
    this.registry.on('error', error => this.emit('coverage-degraded', error))
    this.registry.on('overflow', () => void this.recoverOnce())
    this.registry.start()
    await this.recoverOnce()
    this.publishBarrier = false
    for (const state of this.reducer.snapshots()) this.emit('session-state-updated', state)
  }

  stop(): void {
    this.stopped = true
    this.receiver.stop(); this.registry.stop(); this.removeAllListeners()
  }

  snapshots(): ClaudeSessionState[] { return this.reducer.snapshots() }
  inboxPath(): string { return this.receiver.inboxPath }

  private async consume(record: CollectorRecord): Promise<void> {
    if (this.stopped) return
    if (this.processed.has(record.eventId)) { await this.persist(); return }
    const event = normalizeCollectorRecord(record, ++this.sequence, this.installationId, this.configRootId)
    if (!event) { this.emit('coverage-degraded', new Error(`Unsupported or malformed hook record: ${record.event}`)); return }
    await this.apply(event)
    this.processed.add(record.eventId)
    if (this.processed.size > 2_048) this.processed = new Set([...this.processed].slice(-1_024))
    await this.persist()
  }

  private async recoverOnce(): Promise<void> {
    const sessions = await this.recovery.snapshot()
    for (const session of sessions) await this.apply(recoveryEvent(session, ++this.sequence, 'RecoverySnapshot', this.configRootId))
    const activeIds = new Set(sessions.map(session => session.sessionId))
    for (const state of this.reducer.snapshots()) {
      if (state.lifecycle === 'ended' || activeIds.has(state.sessionId)) continue
      await this.reconcileMissingState(state)
    }
    await this.persist()
  }

  private async reconcileRemovedPid(pid: number): Promise<void> {
    for (const state of this.reducer.snapshots().filter(item => item.pid === pid && item.lifecycle !== 'ended')) await this.reconcileMissingState(state)
    await this.persist()
  }

  private async reconcileMissingState(state: ClaudeSessionState): Promise<void> {
    if (state.pid <= 0 && state.lastEventAt && Date.now() - state.lastEventAt < 30_000) return
    const exists = await this.recovery.processExists(state.pid)
    const kind = exists === false ? 'ProcessExit' : 'RecoveryMissing'
    await this.apply(missingRecoveryEvent(state, ++this.sequence, kind, this.configRootId))
  }

  private async apply(event: NormalizedHookEvent): Promise<void> {
    this.appendJournal(event)
    const state = this.reducer.apply(event)
    if (!this.publishBarrier) this.emit('session-state-updated', state)
  }

  private async persist(): Promise<void> {
    await this.store.save({ schemaVersion: 1, receiverSequence: this.sequence, processedEventIds: [...this.processed], reducer: this.reducer.checkpoint(), events: this.journal, savedAt: Date.now() })
  }

  private appendJournal(event: NormalizedHookEvent): void {
    if (this.journal.some(item => item.eventId === event.eventId)) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.journal.push(event)
    this.journalBytes += bytes
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000
    while (this.journal.length > 10_000 || this.journalBytes > 32 * 1024 * 1024 || (this.journal[0]?.receiverReceivedAt || 0) < cutoff) {
      const removed = this.journal.shift()
      if (!removed) break
      this.journalBytes -= Buffer.byteLength(JSON.stringify(removed))
    }
  }
}
