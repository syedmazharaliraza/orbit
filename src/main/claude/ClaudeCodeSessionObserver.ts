/**
 * ClaudeCodeSessionObserver - Coordinates observation of all Claude Code sessions
 *
 * Responsibilities:
 * - Manage per-session observers
 * - React to discovery events
 * - Aggregate and emit session states
 * - Handle observer lifecycle
 */

import { EventEmitter } from 'node:events'
import { ClaudeCodeSessionDiscovery } from './ClaudeCodeSessionDiscovery'
import { PerSessionObserver } from './PerSessionObserver'
import { HistoryReader } from './HistoryReader'
import type {
  DiscoveredSession,
  ClaudeSessionState,
  SessionDiscoveryEvent,
  ObservationConfig,
  ClaudeSessionStatus
} from './types'
import { DEFAULT_OBSERVATION_CONFIG } from './types'

export class ClaudeCodeSessionObserver extends EventEmitter {
  private discovery: ClaudeCodeSessionDiscovery
  private observers = new Map<string, PerSessionObserver>()
  private historyReader: HistoryReader
  private config: ObservationConfig

  constructor(config: Partial<ObservationConfig> = {}) {
    super()

    this.config = { ...DEFAULT_OBSERVATION_CONFIG, ...config }
    this.discovery = new ClaudeCodeSessionDiscovery(this.config.discoveryInterval)
    this.historyReader = new HistoryReader()

    this.setupDiscoveryHandlers()
  }

  /**
   * Start observing Claude Code sessions
   */
  start(): void {
    this.discovery.start()
  }

  /**
   * Stop observing and clean up all observers
   */
  stop(): void {
    this.discovery.stop()

    // Stop all per-session observers
    for (const observer of this.observers.values()) {
      observer.stop()
    }
    this.observers.clear()

    this.removeAllListeners()
  }

  /**
   * Set up handlers for discovery events
   */
  private setupDiscoveryHandlers(): void {
    this.discovery.on('session-added', (event: SessionDiscoveryEvent) => {
      this.handleSessionAdded(event.session)
    })

    this.discovery.on('session-removed', (event: SessionDiscoveryEvent) => {
      this.handleSessionRemoved(event.session)
    })

    this.discovery.on('session-status-changed', (event: SessionDiscoveryEvent) => {
      this.handleSessionStatusChanged(event.session, event.previousStatus!)
    })

    this.discovery.on('error', (error: Error) => {
      this.emit('error', error)
    })
  }

  /**
   * Handle new session discovered
   */
  private async handleSessionAdded(session: DiscoveredSession): Promise<void> {
    if (this.observers.has(session.sessionId)) {
      // Already observing (shouldn't happen, but handle it)
      return
    }

    // Create per-session observer
    const observer = new PerSessionObserver(
      session,
      this.historyReader,
      this.config.useFilesystemWatching,
      this.config.maxActivityHistory
    )

    // Handle state updates from this observer
    observer.on('state-updated', (state: ClaudeSessionState) => {
      this.emit('session-state-updated', state)
    })

    // Handle session ended
    observer.on('session-ended', (sessionId: string) => {
      // Metadata files may be atomically replaced or disappear before the CLI
      // no longer lists a session. Discovery confirms the exit so workers do
      // not flicker out of Orbit on a transient filesystem event.
      console.log(`[ClaudeCodeSessionObserver] Metadata unavailable for ${sessionId}; awaiting discovery confirmation`)
    })

    // Store observer
    this.observers.set(session.sessionId, observer)

    // Start observing
    try {
      await observer.start()
      this.emit('session-added', session)
    } catch (error) {
      console.error(`[ClaudeCodeSessionObserver] Error starting observer for ${session.sessionId}:`, error)
      observer.stop()
      this.observers.delete(session.sessionId)
    }
  }

  /**
   * Handle session removed
   */
  private handleSessionRemoved(session: DiscoveredSession): void {
    const observer = this.observers.get(session.sessionId)
    if (!observer) return

    // Stop observer
    observer.stop()
    this.observers.delete(session.sessionId)

    this.emit('session-removed', session.sessionId)
  }

  /**
   * Handle session status changed
   */
  private handleSessionStatusChanged(
    session: DiscoveredSession,
    previousStatus: ClaudeSessionStatus
  ): void {
    // Metadata is useful but can lag. Apply the authoritative CLI status now.
    this.observers.get(session.sessionId)?.updateDiscoverySession(session)
    this.emit('session-status-changed', {
      sessionId: session.sessionId,
      status: session.status,
      previousStatus
    })
  }

  /**
   * Get all current session states
   */
  getAllSessionStates(): ClaudeSessionState[] {
    const states: ClaudeSessionState[] = []

    for (const observer of this.observers.values()) {
      states.push(observer.getState())
    }

    return states
  }

  /**
   * Get state for a specific session
   */
  getSessionState(sessionId: string): ClaudeSessionState | null {
    const observer = this.observers.get(sessionId)
    return observer ? observer.getState() : null
  }

  /**
   * Get number of active sessions
   */
  getSessionCount(): number {
    return this.observers.size
  }

  /**
   * Check if discovery is working
   */
  isDiscoveryEnabled(): boolean {
    return this.discovery.isDiscoveryEnabled()
  }
}
