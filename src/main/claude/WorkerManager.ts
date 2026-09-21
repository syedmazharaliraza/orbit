/** Read-only registry of workers observed from local Claude Code sessions. */
import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import type { Worker } from '../../renderer/src/crew'
import type { ClaudeSessionState } from './types'
import { ClaudeSessionToWorkerAdapter } from './ClaudeSessionToWorkerAdapter'
import { HookObservationService } from './hooks/HookObservationService'
import { SessionOpener, type OpenSessionResult } from './SessionOpener'

export type HookHealth = 'healthy' | 'degraded' | 'unknown'

export class WorkerManager extends EventEmitter {
  private readonly useRealSessions = process.env.ORBIT_USE_MOCK_WORKERS !== 'true'
  private observer: HookObservationService | undefined
  private readonly adapter = new ClaudeSessionToWorkerAdapter()
  private readonly workers = new Map<string, Worker>()
  private readonly states = new Map<string, ClaudeSessionState>()
  private readonly sessionOpener = new SessionOpener()
  private window: BrowserWindow | undefined
  private publishTimeout: NodeJS.Timeout | undefined
  private hookHealth: HookHealth = 'unknown'
  private degradedSince: number | undefined

  async initialize(window: BrowserWindow, observationRoot: string): Promise<void> {
    this.window = window
    if (!this.useRealSessions) return this.initializeMockWorkers()

    this.observer = new HookObservationService(observationRoot)
    this.observer.on('session-state-updated', (state: ClaudeSessionState) => {
      this.updateObservedWorker(state)
      // Receiving hook events means hooks are working
      if (this.hookHealth !== 'healthy') {
        this.hookHealth = 'healthy'
        this.degradedSince = undefined
        this.publishHealthStatus()
      }
    })
    this.observer.on('error', (error: Error) => this.emit('integration-error', error))
    this.observer.on('coverage-degraded', (error: Error) => {
      this.emit('integration-error', error)
      if (this.hookHealth !== 'degraded') {
        this.hookHealth = 'degraded'
        this.degradedSince = Date.now()
        this.publishHealthStatus()
      }
    })
    await this.observer.start()
    this.publish()
    this.publishHealthStatus()
  }

  getWorkerSnapshot(): Worker[] { return Array.from(this.workers.values()) }
  getHookHealth(): HookHealth { return this.hookHealth }
  isUsingRealSessions(): boolean { return this.useRealSessions }
  async openSession(sessionId: string): Promise<OpenSessionResult> {
    const state = this.states.get(sessionId)
    if (!state || state.lifecycle === 'ended') return { ok: false, message: 'This Claude session is no longer available.' }
    return this.sessionOpener.focus(state.pid)
  }

  stop(): void {
    if (this.publishTimeout) clearTimeout(this.publishTimeout)
    this.publishTimeout = undefined
    this.observer?.stop()
    this.observer = undefined
    this.workers.clear()
    this.states.clear()
    this.window = undefined
    this.removeAllListeners()
  }

  private updateObservedWorker(state: ClaudeSessionState): void {
    if (state.lifecycle === 'ended') {
      this.workers.delete(state.sessionId)
      this.states.delete(state.sessionId)
      this.schedulePublish()
      return
    }
    this.states.set(state.sessionId, state)
    this.workers.set(state.sessionId, this.adapter.toWorker(state))
    this.schedulePublish()
  }

  private schedulePublish(): void {
    if (this.publishTimeout) return
    this.publishTimeout = setTimeout(() => {
      this.publishTimeout = undefined
      this.publish()
    }, 80)
  }

  private publish(): void {
    this.window?.webContents.send('orbit:workers-updated', this.getWorkerSnapshot())
  }

  private publishHealthStatus(): void {
    this.window?.webContents.send('orbit:hook-health', this.hookHealth)
  }

  private async initializeMockWorkers(): Promise<void> {
    const { crew } = await import('../../renderer/src/crew')
    for (const worker of mockWorkers(crew, process.env.ORBIT_MOCK_SCENARIO)) this.workers.set(worker.id, worker)
    this.publish()
  }
}

/** Development-only fixtures for visually checking every collapsed state. */
function mockWorkers(crew: Worker[], scenario?: string): Worker[] {
  const clone = (worker: Worker, patch: Partial<Worker> = {}): Worker => ({ ...worker, ...patch })
  const quiet = (worker: Worker, state: Worker['state']): Worker => clone(worker, { state, presentation: state === 'done' ? 'done' : state === 'idle' ? 'idle' : 'working', signal: undefined, permission: undefined, question: undefined, waitingFor: undefined })
  switch (scenario) {
    case 'empty': return []
    case 'permission': return [clone(crew[0])]
    case 'input': return [clone(crew[0], { permission: undefined, question: true, waitingFor: 'question', action: 'Which migration should I use?' })]
    case 'waiting': return [clone(crew[0], { permission: undefined, question: undefined, waitingFor: 'Claude Code paused', action: 'waiting' })]
    case 'check': return [clone(crew[3], { permission: undefined, question: undefined, waitingFor: undefined, state: 'stuck', signal: { kind: 'stuck', confidence: 62, evidence: 'Observed repeated tool activity.' } })]
    case 'many': return [
      clone(crew[0]),
      clone(crew[1], { state: 'waiting', presentation: 'waiting', question: true, action: 'Pick an approach.', waitingFor: 'question' }),
      clone(crew[3], { state: 'stuck', presentation: 'attention' })
    ]
    case 'working': return crew.slice(1, 3).map(worker => quiet(worker, 'working'))
    case 'done': return [quiet(crew[2], 'done')]
    case 'idle': return crew.slice(1, 3).map(worker => quiet(worker, 'idle'))
    default: return crew.map(worker => clone(worker))
  }
}
