/**
 * SessionMetadataWatcher - Watches ~/.claude/sessions/<pid>.json for status changes
 *
 * Responsibilities:
 * - Watch session metadata file for changes with fs.watch()
 * - Parse and emit metadata updates
 * - Detect session termination (file deleted)
 * - Fallback to polling if fs.watch() is unreliable
 */

import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionMetadata } from './types'

export class SessionMetadataWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private pollInterval: NodeJS.Timeout | null = null
  private sessionPath: string
  private lastMetadata: SessionMetadata | null = null
  private hasObservedMetadata = false
  private isWatchingReliable = true
  private debounceTimeout: NodeJS.Timeout | null = null

  constructor(private pid: number, private useFilesystemWatching = true) {
    super()
    this.sessionPath = join(homedir(), '.claude', 'sessions', `${pid}.json`)
  }

  /**
   * Start watching the session metadata file
   */
  async start(): Promise<void> {
    // Try initial read
    await this.readAndEmit()

    // Set up filesystem watching if enabled
    if (this.useFilesystemWatching) {
      try {
        this.watcher = watch(this.sessionPath, (eventType) => {
          this.onFileChange(eventType)
        })

        this.watcher.on('error', (error) => {
          console.warn(`[SessionMetadataWatcher] fs.watch failed for pid ${this.pid}, falling back to polling:`, error)
          this.isWatchingReliable = false
          this.fallbackToPolling()
        })
      } catch (error) {
        console.warn(`[SessionMetadataWatcher] Could not start fs.watch for pid ${this.pid}, using polling:`, error)
        this.isWatchingReliable = false
        this.fallbackToPolling()
      }
    } else {
      // Polling requested explicitly
      this.fallbackToPolling()
    }
  }

  /**
   * Stop watching and clean up
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
      this.debounceTimeout = null
    }

    this.removeAllListeners()
  }

  /**
   * Handle file change events from fs.watch()
   * Debounced to handle rapid sequential writes
   */
  private onFileChange(eventType: string): void {
    // Debounce rapid changes (100ms)
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
    }

    this.debounceTimeout = setTimeout(() => {
      this.debounceTimeout = null

      // Editors and Claude Code can replace JSON files atomically, producing a
      // rename even though a replacement is already present. Verify by reading
      // rather than treating the notification itself as session termination.
      void eventType
      this.readAndEmit()
    }, 100)
  }

  /**
   * Fallback to polling when fs.watch is unavailable or unreliable
   */
  private fallbackToPolling(): void {
    if (this.pollInterval) return // Already polling

    // Poll every 1 second
    this.pollInterval = setInterval(() => {
      this.readAndEmit()
    }, 1000)
  }

  /**
   * Read metadata file and emit if changed
   */
  private async readAndEmit(): Promise<void> {
    try {
      // Check if file still exists
      try {
        await stat(this.sessionPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.handleSessionEnded()
          return
        }
        throw error
      }

      // Read and parse metadata
      const content = await readFile(this.sessionPath, 'utf-8')
      const metadata: SessionMetadata = JSON.parse(content)

      // Only emit if metadata has actually changed
      if (this.hasChanged(metadata)) {
        this.lastMetadata = metadata
        this.hasObservedMetadata = true
        this.emit('metadata-updated', metadata)
      }
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code

      if (errno === 'ENOENT') {
        // File deleted - session ended
        this.handleSessionEnded()
      } else if (errno === 'EACCES') {
        // Permission denied
        this.emit('error', new Error(`Permission denied reading session file for pid ${this.pid}`))
      } else {
        // Parse error or other issue
        console.error(`[SessionMetadataWatcher] Error reading metadata for pid ${this.pid}:`, error)
      }
    }
  }

  /**
   * Check if metadata has meaningfully changed
   */
  private hasChanged(metadata: SessionMetadata): boolean {
    if (!this.lastMetadata) return true

    // Compare fields that matter for observation
    return (
      this.lastMetadata.status !== metadata.status ||
      this.lastMetadata.waitingFor !== metadata.waitingFor ||
      this.lastMetadata.statusUpdatedAt !== metadata.statusUpdatedAt ||
      this.lastMetadata.name !== metadata.name
    )
  }

  /**
   * Handle session termination
   */
  private handleSessionEnded(): void {
    // Discovery can be authoritative even when the metadata file is missing
    // (for example during atomic replacement, or when Claude is launched with
    // a restricted session directory). Keep retrying until we have observed a
    // real metadata record at least once; only then does disappearance mean
    // the session ended.
    if (!this.hasObservedMetadata) return
    this.emit('session-ended', this.pid)
    this.stop()
  }

  /**
   * Get the last known metadata (useful for immediate access)
   */
  getLastMetadata(): SessionMetadata | null {
    return this.lastMetadata
  }
}
