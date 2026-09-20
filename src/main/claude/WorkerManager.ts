/** Read-only registry of workers observed from local Claude Code sessions. */
import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import type { Worker } from '../../renderer/src/crew'
import type { ClaudeSessionState } from './types'
import { ClaudeCodeSessionObserver } from './ClaudeCodeSessionObserver'
import { ClaudeSessionToWorkerAdapter } from './ClaudeSessionToWorkerAdapter'

export class WorkerManager extends EventEmitter {
  private readonly useRealSessions = process.env.ORBIT_USE_MOCK_WORKERS !== 'true'
  private observer: ClaudeCodeSessionObserver | undefined
  private readonly adapter = new ClaudeSessionToWorkerAdapter()
  private readonly workers = new Map<string, Worker>()
  private window: BrowserWindow | undefined
  private publishTimeout: NodeJS.Timeout | undefined
  private attentionRefreshInterval: NodeJS.Timeout | undefined

  async initialize(window: BrowserWindow): Promise<void> {
    this.window = window
    if (!this.useRealSessions) return this.initializeMockWorkers()

    this.observer = new ClaudeCodeSessionObserver()
    this.observer.on('session-state-updated', (state: ClaudeSessionState) => this.updateObservedWorker(state))
    this.observer.on('session-removed', (sessionId: string) => {
      this.workers.delete(sessionId)
      this.publish()
    })
    this.observer.on('error', (error: Error) => this.emit('integration-error', error))
    this.observer.start()
    // Time-based heuristic labels may age without a new filesystem event.
    this.attentionRefreshInterval = setInterval(() => this.refreshObservedWorkers(), 5_000)
    this.publish()
  }

  getWorkerSnapshot(): Worker[] { return Array.from(this.workers.values()) }
  isUsingRealSessions(): boolean { return this.useRealSessions }

  stop(): void {
    if (this.publishTimeout) clearTimeout(this.publishTimeout)
    if (this.attentionRefreshInterval) clearInterval(this.attentionRefreshInterval)
    this.publishTimeout = undefined
    this.attentionRefreshInterval = undefined
    this.observer?.stop()
    this.observer = undefined
    this.workers.clear()
    this.window = undefined
    this.removeAllListeners()
  }

  private updateObservedWorker(state: ClaudeSessionState): void {
    this.workers.set(state.sessionId, this.adapter.toWorker(state))
    this.schedulePublish()
  }

  private refreshObservedWorkers(): void {
    for (const state of this.observer?.getAllSessionStates() || []) this.workers.set(state.sessionId, this.adapter.toWorker(state))
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
