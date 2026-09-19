/**
 * ClaudeCodeSessionDiscovery - Discovers active Claude Code sessions
 *
 * Responsibilities:
 * - Execute `claude agents --json` every 3 seconds
 * - Parse JSON output
 * - Detect added/removed/status-changed sessions
 * - Emit discovery events
 */

import { EventEmitter } from 'node:events'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeSessionStatus, DiscoveredSession, SessionDiscoveryEvent, SessionMetadata } from './types'

const execAsync = promisify(exec)

export class ClaudeCodeSessionDiscovery extends EventEmitter {
  private knownSessions = new Map<string, DiscoveredSession>()
  private pollInterval: NodeJS.Timeout | null = null
  private discoveryInterval: number
  private isEnabled = true
  private retryCount = 0
  private maxRetries = 3
  private missedPolls = new Map<string, number>()

  constructor(discoveryInterval = 3000) {
    super()
    this.discoveryInterval = discoveryInterval
  }

  /**
   * Start session discovery
   */
  start(): void {
    if (this.pollInterval) return // Already started

    // Immediate first poll
    this.poll()

    // Then poll at regular interval
    this.pollInterval = setInterval(() => {
      this.poll()
    }, this.discoveryInterval)
  }

  /**
   * Stop session discovery
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    this.removeAllListeners()
  }

  /**
   * Poll for active sessions
   */
  private async poll(): Promise<void> {
    if (!this.isEnabled) return

    try {
      const sessions = await this.executeClaudeAgents()
      this.processSessionList(sessions)
      this.retryCount = 0 // Reset on success
    } catch (error) {
      this.handlePollError(error as Error)
    }
  }

  /**
   * Execute `claude agents --json` and parse output
   */
  private async executeClaudeAgents(): Promise<DiscoveredSession[]> {
    let cliSessions: DiscoveredSession[] = []
    try {
      const { stdout } = await execAsync('claude agents --json', {
        timeout: 5000, // 5 second timeout
        maxBuffer: 1024 * 1024 // 1MB buffer
      })

      const trimmed = stdout.trim()
      if (trimmed) {
        const sessions = JSON.parse(trimmed) as DiscoveredSession[]
        cliSessions = Array.isArray(sessions) ? sessions : []
      }
    } catch (error) {
      const execError = error as { code?: string; stderr?: string }

      if (execError.code === 'ENOENT' || execError.stderr?.includes('command not found')) {
        // The session files are still a useful read-only fallback when the
        // CLI is unavailable from Electron's PATH.
        return this.readLiveSessionFiles()
      }
    }

    // `claude agents --json` currently omits this interactive waiting session
    // on some Claude Code versions. Merge the metadata files so waiting state
    // cannot make an otherwise live worker disappear from Orbit.
    const fileSessions = await this.readLiveSessionFiles()
    const merged = new Map(cliSessions.map(session => [session.sessionId, session]))
    for (const session of fileSessions) merged.set(session.sessionId, session)
    return Array.from(merged.values())
  }

  private async readLiveSessionFiles(): Promise<DiscoveredSession[]> {
    const sessionsDirectory = join(homedir(), '.claude', 'sessions')
    let filenames: string[]
    try {
      filenames = await readdir(sessionsDirectory)
    } catch {
      return []
    }

    const sessions: DiscoveredSession[] = []
    for (const filename of filenames) {
      if (!filename.endsWith('.json')) continue
      try {
        const metadata = JSON.parse(await readFile(join(sessionsDirectory, filename), 'utf8')) as Partial<SessionMetadata>
        if (!this.isLiveProcess(metadata.pid) || typeof metadata.sessionId !== 'string' || typeof metadata.cwd !== 'string') continue
        const status = this.normalizeStatus(metadata.status)
        if (!status || typeof metadata.startedAt !== 'number') continue
        sessions.push({
          pid: metadata.pid,
          cwd: metadata.cwd,
          kind: metadata.kind || 'interactive',
          startedAt: metadata.startedAt,
          sessionId: metadata.sessionId,
          name: metadata.name || `session-${metadata.pid}`,
          status,
          waitingFor: metadata.waitingFor
        })
      } catch {
        // Ignore files being atomically replaced or partially written.
      }
    }
    return sessions
  }

  private normalizeStatus(status: unknown): ClaudeSessionStatus | undefined {
    if (status === 'busy' || status === 'idle' || status === 'waiting') return status
    return undefined
  }

  private isLiveProcess(pid: unknown): pid is number {
    // Do not signal or otherwise probe observed processes. The CLI remains
    // authoritative when available; metadata is a best-effort fallback.
    return typeof pid === 'number' && pid > 0
  }

  /**
   * Process the list of discovered sessions
   */
  private processSessionList(sessions: DiscoveredSession[]): void {
    const currentSessionIds = new Set(sessions.map(s => s.sessionId))

    // A single empty/missing CLI snapshot should not make a worker vanish and
    // reappear. Require two consecutive misses; `claude agents --json` remains
    // the authority for final removal, just with one-poll hysteresis.
    for (const [id, session] of this.knownSessions) {
      if (!currentSessionIds.has(id)) {
        const misses = (this.missedPolls.get(id) || 0) + 1
        if (misses >= 2) {
          this.emit('session-removed', {
            type: 'removed',
            session
          } as SessionDiscoveryEvent)
          this.knownSessions.delete(id)
          this.missedPolls.delete(id)
        } else {
          this.missedPolls.set(id, misses)
        }
      }
    }

    // Detect added and status-changed sessions
    for (const session of sessions) {
      this.missedPolls.delete(session.sessionId)
      const previous = this.knownSessions.get(session.sessionId)

      if (!previous) {
        // New session
        this.knownSessions.set(session.sessionId, session)
        this.emit('session-added', {
          type: 'added',
          session
        } as SessionDiscoveryEvent)
      } else if (previous.status !== session.status) {
        // Status changed
        this.knownSessions.set(session.sessionId, session)
        this.emit('session-status-changed', {
          type: 'status-changed',
          session,
          previousStatus: previous.status
        } as SessionDiscoveryEvent)
      } else {
        // Update stored session with latest data
        this.knownSessions.set(session.sessionId, session)
      }
    }
  }

  /**
   * Handle polling errors with exponential backoff
   */
  private handlePollError(error: Error): void {
    if (error.message === 'CLAUDE_NOT_FOUND') {
      console.error('[ClaudeCodeSessionDiscovery] Claude Code not found in PATH')
      this.emit('error', new Error('Claude Code CLI not found. Please install or add to PATH.'))
      this.isEnabled = false
      this.stop()
      return
    }

    this.retryCount++

    if (this.retryCount >= this.maxRetries) {
      console.error(`[ClaudeCodeSessionDiscovery] Max retries (${this.maxRetries}) exceeded:`, error)
      this.emit('error', error)
      // Keep trying but at slower rate
      this.discoveryInterval = 10000 // Slow down to 10s
      this.retryCount = 0
    } else {
      console.warn(`[ClaudeCodeSessionDiscovery] Poll error (retry ${this.retryCount}/${this.maxRetries}):`, error)
    }
  }

  /**
   * Get all known sessions
   */
  getKnownSessions(): DiscoveredSession[] {
    return Array.from(this.knownSessions.values())
  }

  /**
   * Check if discovery is enabled
   */
  isDiscoveryEnabled(): boolean {
    return this.isEnabled
  }
}
