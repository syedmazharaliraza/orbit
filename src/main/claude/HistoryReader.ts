/**
 * HistoryReader - Reads initial task text from ~/.claude/history.jsonl
 *
 * Responsibilities:
 * - Find the most recent prompt for a given session ID
 * - Cache results (tasks don't change during session lifetime)
 * - Handle missing entries gracefully
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HistoryEntry } from './types'

export class HistoryReader {
  private cache = new Map<string, string>()
  private historyPath: string

  constructor() {
    this.historyPath = join(homedir(), '.claude', 'history.jsonl')
  }

  /**
   * Get the initial task text for a session
   * Returns cached value if available, otherwise searches history.jsonl
   */
  async getTaskForSession(sessionId: string): Promise<string | null> {
    // Check cache first
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId)!
    }

    // Search history file
    const task = await this.findInHistory(sessionId)

    // Cache result (even if null - we don't need to search again)
    if (task) {
      this.cache.set(sessionId, task)
    }

    return task
  }

  /**
   * Search backwards through history.jsonl for the most recent entry
   * Only reads last 1000 lines for performance
   */
  private async findInHistory(sessionId: string): Promise<string | null> {
    try {
      const content = await readFile(this.historyPath, 'utf-8')
      const lines = content.trim().split('\n')

      // Search backwards for most recent match
      // Only check last 1000 lines for performance
      const startIndex = Math.max(0, lines.length - 1000)

      for (let i = lines.length - 1; i >= startIndex; i--) {
        const line = lines[i].trim()
        if (!line) continue

        try {
          const entry: HistoryEntry = JSON.parse(line)
          if (entry.sessionId === sessionId) {
            const display = this.cleanDisplay(entry.display)
            if (display) return display
          }
        } catch (parseError) {
          // Skip malformed lines
          continue
        }
      }

      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // History file doesn't exist - not an error
        return null
      }

      console.error('[HistoryReader] Error reading history:', error)
      return null
    }
  }

  private cleanDisplay(display: unknown): string | null {
    if (typeof display !== 'string') return null
    const value = display.replace(/\s+/g, ' ').trim()
    if (!value || value.startsWith('/') || value.startsWith('[Pasted') || value.startsWith('<')) return null
    return value.length > 360 ? `${value.slice(0, 359).trimEnd()}…` : value
  }

  /**
   * Clear the cache (useful for testing or on app restart)
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; sessionIds: string[] } {
    return {
      size: this.cache.size,
      sessionIds: Array.from(this.cache.keys())
    }
  }
}
