/**
 * ClaudeCodeSessionObserver - Coordinates observation of all Claude Code sessions via hooks
 *
 * Responsibilities:
 * - Manage OrbitHookServer and OrbitHookInstaller
 * - Route hook events to per-session HookEventProcessors
 * - One-time discovery at startup for existing sessions
 * - Aggregate and emit session states
 * - Handle processor lifecycle
 */

import { EventEmitter } from 'node:events'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { OrbitHookServer, type HookEvent } from './OrbitHookServer'
import { OrbitHookInstaller } from './OrbitHookInstaller'
import { HookEventProcessor } from './HookEventProcessor'
import type { ClaudeSessionState, DiscoveredSession } from './types'

const execAsync = promisify(exec)

export class ClaudeCodeSessionObserver extends EventEmitter {
  private hookServer: OrbitHookServer
  private hookInstaller: OrbitHookInstaller | null = null
  private processors = new Map<string, HookEventProcessor>()
  private isStarted = false

  constructor() {
    super()
    this.hookServer = new OrbitHookServer()
  }

  /**
   * Start observing Claude Code sessions via hooks
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      console.warn('[ClaudeCodeSessionObserver] Already started')
      return
    }

    try {
      // Start HTTP server for hooks
      const port = await this.hookServer.start()
      console.log(`[ClaudeCodeSessionObserver] Hook server started on port ${port}`)

      // Install hooks in Claude Code settings
      this.hookInstaller = new OrbitHookInstaller(port)
      await this.hookInstaller.install()
      console.log('[ClaudeCodeSessionObserver] Hooks installed')

      // Set up hook event handler
      this.hookServer.on('hook-event', (event: HookEvent) => {
        this.processHookEvent(event.eventType, event.sessionId, event.payload)
      })

      // Discover existing sessions (one-time catch-up)
      await this.discoverExistingSessions()

      this.isStarted = true
      console.log('[ClaudeCodeSessionObserver] Observation started')
    } catch (error) {
      console.error('[ClaudeCodeSessionObserver] Failed to start:', error)
      throw error
    }
  }

  /**
   * Stop observing and clean up
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      return
    }

    console.log('[ClaudeCodeSessionObserver] Stopping observation...')

    // Uninstall hooks
    if (this.hookInstaller) {
      await this.hookInstaller.uninstall()
      this.hookInstaller = null
    }

    // Stop hook server
    this.hookServer.stop()

    // Stop all processors
    for (const processor of this.processors.values()) {
      processor.stop()
    }
    this.processors.clear()

    this.removeAllListeners()
    this.isStarted = false

    console.log('[ClaudeCodeSessionObserver] Observation stopped')
  }

  /**
   * Discover existing sessions using one-time `claude agents --json`
   */
  private async discoverExistingSessions(): Promise<void> {
    try {
      const { stdout } = await execAsync('claude agents --json')
      const sessions = JSON.parse(stdout) as DiscoveredSession[]

      console.log(
        `[ClaudeCodeSessionObserver] Discovered ${sessions.length} existing session(s)`
      )

      for (const session of sessions) {
        this.createProcessor(session)
      }
    } catch (error) {
      const execError = error as { code?: number; stderr?: string }
      if (execError.code === 127 || execError.stderr?.includes('command not found')) {
        console.warn(
          '[ClaudeCodeSessionObserver] Claude Code CLI not found - skipping startup discovery'
        )
      } else {
        console.error('[ClaudeCodeSessionObserver] Error during startup discovery:', error)
      }
    }
  }

  /**
   * Process incoming hook event
   */
  private processHookEvent(
    eventType: string,
    sessionId: string,
    payload: Record<string, unknown>
  ): void {
    // Handle SessionStart - create new processor if needed
    if (eventType === 'SessionStart') {
      if (!this.processors.has(sessionId)) {
        const session: Partial<DiscoveredSession> = {
          sessionId,
          pid: payload.pid as number,
          name: payload.name as string,
          cwd: payload.cwd as string,
          kind: payload.kind as string,
          startedAt: payload.startedAt as number,
          status: 'busy'
        }
        this.createProcessor(session)
      }
    }

    // Route event to appropriate processor
    const processor = this.processors.get(sessionId)
    if (processor) {
      processor.processEvent(eventType, { session_id: sessionId, ...payload })
    } else {
      console.warn(
        `[ClaudeCodeSessionObserver] No processor for session ${sessionId}, event: ${eventType}`
      )
    }

    // Handle SessionEnd/Stop - remove processor
    if (eventType === 'SessionEnd' || eventType === 'Stop') {
      this.removeProcessor(sessionId)
    }
  }

  /**
   * Create a new processor for a session
   */
  private createProcessor(session: Partial<DiscoveredSession>): void {
    const sessionId = session.sessionId!

    if (this.processors.has(sessionId)) {
      console.warn(`[ClaudeCodeSessionObserver] Processor already exists for ${sessionId}`)
      return
    }

    const processor = new HookEventProcessor(sessionId, {
      pid: session.pid || 0,
      name: session.name || 'Unknown',
      cwd: session.cwd || '~',
      kind: session.kind || 'unknown',
      startedAt: session.startedAt || Date.now(),
      status: session.status || 'busy'
    })

    // Handle state updates
    processor.on('state-updated', (state: ClaudeSessionState) => {
      this.emit('session-state-updated', state)
    })

    // Handle session ended
    processor.on('session-ended', (endedSessionId: string) => {
      console.log(`[ClaudeCodeSessionObserver] Session ended: ${endedSessionId}`)
      this.removeProcessor(endedSessionId)
    })

    this.processors.set(sessionId, processor)
    this.emit('session-added', session as DiscoveredSession)

    console.log(`[ClaudeCodeSessionObserver] Created processor for session ${sessionId}`)
  }

  /**
   * Remove a processor for a session
   */
  private removeProcessor(sessionId: string): void {
    const processor = this.processors.get(sessionId)
    if (!processor) {
      return
    }

    processor.stop()
    this.processors.delete(sessionId)
    this.emit('session-removed', sessionId)

    console.log(`[ClaudeCodeSessionObserver] Removed processor for session ${sessionId}`)
  }

  /**
   * Get all current session states
   */
  getAllSessionStates(): ClaudeSessionState[] {
    const states: ClaudeSessionState[] = []

    for (const processor of this.processors.values()) {
      states.push(processor.getState())
    }

    return states
  }

  /**
   * Get state for a specific session
   */
  getSessionState(sessionId: string): ClaudeSessionState | null {
    const processor = this.processors.get(sessionId)
    return processor ? processor.getState() : null
  }

  /**
   * Get number of active sessions
   */
  getSessionCount(): number {
    return this.processors.size
  }
}
