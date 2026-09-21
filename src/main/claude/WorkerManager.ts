/** Read-only registry of workers observed from local Claude Code sessions. */
import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import type { Worker } from '../../renderer/src/crew'
import type { ClaudeSessionState } from './types'
import { ClaudeSessionToWorkerAdapter } from './ClaudeSessionToWorkerAdapter'
import { HookObservationService } from './hooks/HookObservationService'
import { SessionOpener, type OpenSessionResult } from './SessionOpener'

export class WorkerManager extends EventEmitter {
  private readonly useRealSessions = process.env.ORBIT_USE_MOCK_WORKERS !== 'true'
  private observer: HookObservationService | undefined
  private readonly adapter = new ClaudeSessionToWorkerAdapter()
  private readonly workers = new Map<string, Worker>()
  private readonly states = new Map<string, ClaudeSessionState>()
  private readonly sessionOpener = new SessionOpener()
  private window: BrowserWindow | undefined
  private publishTimeout: NodeJS.Timeout | undefined
  private readonly displayDeadlines = new Map<string, NodeJS.Timeout>()

  async initialize(window: BrowserWindow, observationRoot: string): Promise<void> {
    this.window = window
    if (!this.useRealSessions) return this.initializeMockWorkers()

    this.observer = new HookObservationService(observationRoot)
    this.observer.on('session-state-updated', (state: ClaudeSessionState) => this.updateObservedWorker(state))
    this.observer.on('error', (error: Error) => this.emit('integration-error', error))
    this.observer.on('coverage-degraded', (error: Error) => this.emit('integration-error', error))
    await this.observer.start()
    this.publish()
  }

  getWorkerSnapshot(): Worker[] { return Array.from(this.workers.values()) }
  isUsingRealSessions(): boolean { return this.useRealSessions }
  async openSession(sessionId: string): Promise<OpenSessionResult> {
    const state = this.states.get(sessionId)
    if (!state || state.lifecycle === 'ended') return { ok: false, message: 'This Claude session is no longer available.' }
    return this.sessionOpener.focus(state.pid)
  }

  stop(): void {
    if (this.publishTimeout) clearTimeout(this.publishTimeout)
    for (const deadline of this.displayDeadlines.values()) clearTimeout(deadline)
    this.publishTimeout = undefined
    this.displayDeadlines.clear()
    this.observer?.stop()
    this.observer = undefined
    this.workers.clear()
    this.states.clear()
    this.window = undefined
    this.removeAllListeners()
  }

  private updateObservedWorker(state: ClaudeSessionState): void {
    if (state.lifecycle === 'ended') {
      const deadline = this.displayDeadlines.get(state.sessionId)
      if (deadline) clearTimeout(deadline)
      this.displayDeadlines.delete(state.sessionId)
      this.workers.delete(state.sessionId)
      this.states.delete(state.sessionId)
      this.schedulePublish()
      return
    }
    this.states.set(state.sessionId, state)
    this.workers.set(state.sessionId, this.adapter.toWorker(state))
    this.scheduleDisplayDeadline(state)
    this.schedulePublish()
  }

  private scheduleDisplayDeadline(state: ClaudeSessionState): void {
    const previous = this.displayDeadlines.get(state.sessionId)
    if (previous) clearTimeout(previous)
    this.displayDeadlines.delete(state.sessionId)
    if (!state.responseFinishedAt) return
    const delay = Math.max(0, state.responseFinishedAt + 20_000 - Date.now())
    if (delay === 0) return
    this.displayDeadlines.set(state.sessionId, setTimeout(() => {
      this.displayDeadlines.delete(state.sessionId)
      const current = this.observer?.snapshots().find(item => item.sessionId === state.sessionId)
      if (current) { this.workers.set(current.sessionId, this.adapter.toWorker(current)); this.schedulePublish() }
    }, delay))
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

  private async initializeMockWorkers(): Promise<void> {
    const { crew } = await import('../../renderer/src/crew')
    for (const worker of mockWorkers(crew, process.env.ORBIT_MOCK_SCENARIO)) this.workers.set(worker.id, worker)
    this.publish()
  }
}

/** Development-only fixtures for visually checking every collapsed state. */
function mockWorkers(crew: Worker[], scenario?: string): Worker[] {
  const clone = (worker: Worker, patch: Partial<Worker> = {}): Worker => ({ ...worker, ...patch })
  const quiet = (worker: Worker, state: Worker['state']): Worker => clone(worker, { state, signal: undefined, permission: undefined, question: undefined, waitingFor: undefined })
  switch (scenario) {
    case 'empty': return []
    case 'permission': return [clone(crew[0])]
    case 'input': return [clone(crew[0], { permission: undefined, question: { questions: [{ question: 'Which migration should I use?', options: [] }] }, waitingFor: 'question', action: 'waiting for your answer' })]
    case 'waiting': return [clone(crew[0], { permission: undefined, question: undefined, waitingFor: 'Claude Code paused', action: 'waiting' })]
    case 'check': return [clone(crew[3], { permission: undefined, question: undefined, waitingFor: undefined, state: 'stuck', signal: { kind: 'stuck', confidence: 62, evidence: 'Observed repeated tool activity.' } })]
    case 'many': return [
      clone(crew[0]),
      clone(crew[1], { state: 'waiting', presentation: 'waiting', question: { questions: [{ question: 'Pick an approach.', options: [] }] }, waitingFor: 'question' }),
      clone(crew[3], { state: 'stuck', presentation: 'attention' })
    ]
    case 'working': return crew.slice(1, 3).map(worker => quiet(worker, 'working'))
    case 'done': return [quiet(crew[2], 'done')]
    case 'idle': return crew.slice(1, 3).map(worker => quiet(worker, 'idle'))
    default: return crew.map(worker => clone(worker))
  }
}
