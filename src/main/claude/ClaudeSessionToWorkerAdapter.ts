/**
 * ClaudeSessionToWorkerAdapter - Maps Claude Code session state to Worker model
 *
 * Responsibilities:
 * - Transform ClaudeSessionState into Worker type
 * - Handle observed/derived/inferred/mocked field semantics
 * - Provide fallback values for unavailable data
 * - Document field sources clearly
 */

import type { Worker, Mark, FileTag } from '../../renderer/src/crew'
import type { ClaudeSessionState, WorkerFieldMetadata } from './types'
import { classifySessionAttention } from './AttentionClassifier'

export class ClaudeSessionToWorkerAdapter {
  /**
   * Convert ClaudeSessionState to Worker
   */
  toWorker(session: ClaudeSessionState): Worker {
    const attention = classifySessionAttention(session)
    return {
      // === OBSERVED FIELDS (from Claude Code data) ===
      id: this.sessionIdToShortId(session.sessionId),
      name: this.deriveWorkerName(session.name),
      task: session.lastPrompt || session.initialTask || 'No prompt observed',
      state: attention.state,
      presentation: attention.presentation,
      elapsed: this.calculateElapsed(session.startedAt),
      repo: this.extractRepoName(session.cwd),
      file: session.currentFile || '',
      fileTag: (session.fileOperation || 'READING') as FileTag,
      tool: this.formatToolName(session.currentTool, session.toolLifecycle),
      activity: session.activity || [],
      budget: this.calculateBudget(session.tokensRemaining, session.tokensTotal),
      context: this.formatContext(session),
      tools: session.tools?.map(tool => ({ name: tool.name, count: tool.count })),
      relevantFiles: session.relevantFiles,
      usage: session.usage,
      promptContext: session.promptContext,

      // === DERIVED FIELDS (computed from observed data) ===
      action: this.deriveAction(session, attention.state),
      path: this.extractPath(session.currentFile),

      // === INFERRED FIELDS (reasonable defaults from available data) ===
      priority: attention.priority,
      hue: this.assignHue(session.sessionId),
      mark: this.assignMark(session.sessionId),
      branch: session.gitBranch || '',
      model: this.formatModel(session.model),
      effort: this.formatEffort(session.effort),
      delay: this.animationDelay(session.sessionId),

      // === MOCKED/UNAVAILABLE FIELDS (not observable in Stage 6) ===
      edit: '', // Would need diff analysis
      cost: '', // Would need API call tracking
      message: session.lastAssistantMessage || '',
      progress: undefined, // Not available from observation
      filesGiven: undefined, // Not available from observation
      foundFiles: undefined, // Not available from observation
      permission: session.permission,
      question: session.question,
      waitingFor: session.waitingFor,
      signal: attention.signal,
      canOpenSession: session.pid > 0 && session.lifecycle !== 'ended'
    }
  }

  // ========================================================================
  // OBSERVED FIELD MAPPERS
  // ========================================================================

  private sessionIdToShortId(sessionId: string): string {
    // Keep the complete observed ID: short UUID prefixes can collide when
    // several live Claude sessions are shown together.
    return sessionId
  }

  private deriveWorkerName(sessionName: string): string {
    // Session names like "orbit-50" -> "Orbit"
    // Keep first word, capitalize
    const base = sessionName.split('-')[0] || sessionName
    return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()
  }

  private calculateElapsed(startedAt: number): string {
    const now = Date.now()
    const elapsed = now - startedAt

    const minutes = Math.floor(elapsed / 60000)
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60

    if (hours > 0) {
      return `${hours}h${mins.toString().padStart(2, '0')}`
    } else {
      return `${mins}m`
    }
  }

  private extractRepoName(cwd: string): string {
    const parts = cwd.split('/')
    return parts[parts.length - 1] || 'unknown'
  }

  private formatToolName(tool: string | undefined, lifecycle?: 'active' | 'finished'): string {
    if (!tool) return ''

    // Format tool names nicely: "Edit" -> "edit", "Bash" -> "bash"
    const formatted = tool.toLowerCase()

    // Add context for common tools
    const prefix = lifecycle === 'finished' ? 'finished · ' : ''
    if (formatted === 'bash') return `${prefix}bash`
    if (formatted === 'edit') return `${prefix}edit`
    if (formatted === 'read') return `${prefix}read`
    if (formatted === 'write') return `${prefix}write`

    return `${prefix}${formatted}`
  }

  private calculateBudget(remaining: number | undefined, total: number | undefined): number | undefined {
    if (remaining === undefined || total === undefined || total <= 0) return undefined
    return Math.round((remaining / total) * 100)
  }

  private formatContext(session: ClaudeSessionState): string {
    const { tokensRemaining: remaining, tokensTotal: total, usage } = session
    if (remaining !== undefined && total !== undefined) return `${this.formatTokens(remaining)} / ${this.formatTokens(total)} ctx`
    if (remaining !== undefined) return `${this.formatTokens(remaining)} ctx left`
    if (usage) return `${this.formatTokens(usage.totalTokens)} used · ${usage.turnCount} turn${usage.turnCount === 1 ? '' : 's'}`
    return 'context pending'
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
    return `${tokens}`
  }

  // ========================================================================
  // DERIVED FIELD MAPPERS
  // ========================================================================

  private deriveAction(session: ClaudeSessionState, workerState: Worker['state']): string {
    const { currentTool: tool, currentFile: file, activityPhase } = session
    if (workerState === 'waiting' && !session.permission) return session.question ? 'question · waiting for your choice' : 'waiting for you'
    if (activityPhase === 'starting') return 'starting…'
    if (activityPhase === 'processing') return 'processing…'
    if (activityPhase === 'assistant') return 'assistant response'
    if (activityPhase === 'waiting') return 'waiting for you'
    if (activityPhase === 'permission') return `approval · ${session.permission?.command || 'requested'}`
    if (workerState === 'done') return 'finished · recent tool'
    if (activityPhase === 'idle') return 'idle'
    if (!tool) return ''

    const toolLower = tool.toLowerCase()
    const fileName = file ? file.split('/').pop() : ''

    if (activityPhase === 'tool-finished') {
      return `finished · ${toolLower}${fileName ? ` ${fileName}` : ''}`
    }

    if (fileName) {
      return `${toolLower} · ${fileName}`
    } else if (toolLower === 'bash') {
      return 'bash'
    } else {
      return toolLower
    }
  }

  private extractPath(file: string | undefined): string {
    if (!file) return ''

    const parts = file.split('/')
    parts.pop() // Remove filename
    const path = parts.join('/')

    // Return relative path from project root
    return path.replace(/^.*\/src/, 'src') || ''
  }

  // ========================================================================
  // INFERRED FIELD MAPPERS
  // ========================================================================

  private assignHue(sessionId: string): number {
    // Deterministic hue from session ID for consistent colors
    let hash = 0
    for (let i = 0; i < sessionId.length; i++) {
      hash = ((hash << 5) - hash) + sessionId.charCodeAt(i)
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash) % 360
  }

  private assignMark(sessionId: string): Mark {
    const marks: Mark[] = ['bar', 'dot', 'two', 'ring', 'diamond', 'square']
    // Use first character of session ID
    const charCode = sessionId.charCodeAt(0)
    return marks[charCode % marks.length]
  }

  private formatModel(model: string | undefined): string {
    if (!model) return 'model unavailable'
    const match = model.match(/(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)-(\d+))?/i)
    if (!match) return model
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
    return match[2] && match[3] ? `${family} ${match[2]}.${match[3]}` : family
  }

  private formatEffort(effort: string | undefined): string {
    return effort ? effort.toLowerCase() : 'effort unavailable'
  }

  private animationDelay(sessionId: string): string {
    // A deterministic delay avoids restarting an astronaut's animation on
    // every observed state update.
    const delays = ['-0.2s', '-0.5s', '-0.8s', '-1.1s', '-1.4s', '-1.7s', '-2.0s']
    let hash = 0
    for (let index = 0; index < sessionId.length; index++) hash = ((hash << 5) - hash) + sessionId.charCodeAt(index)
    return delays[Math.abs(hash) % delays.length]
  }

  // ========================================================================
  // FIELD METADATA (for documentation)
  // ========================================================================

  static getFieldMetadata(): WorkerFieldMetadata[] {
    return [
      { field: 'id', source: 'observed', description: 'From sessionId (truncated)' },
      { field: 'name', source: 'observed', description: 'From session.name' },
      { field: 'task', source: 'observed', description: 'From latest prompt or history entry' },
      { field: 'state', source: 'derived', description: 'Observed phase/status plus explicit Stage 8 attention rules' },
      { field: 'presentation', source: 'derived', description: 'User-facing label derived from observed phase/status' },
      { field: 'elapsed', source: 'observed', description: 'Calculated from startedAt' },
      { field: 'repo', source: 'observed', description: 'Extracted from cwd' },
      { field: 'file', source: 'observed', description: 'From currentFile (transcript)' },
      { field: 'fileTag', source: 'observed', description: 'From fileOperation (transcript)' },
      { field: 'tool', source: 'observed', description: 'From currentTool (transcript)' },
      { field: 'activity', source: 'observed', description: 'From transcript events' },
      { field: 'budget', source: 'observed', description: 'Only calculated when both token bounds are observed' },
      { field: 'context', source: 'observed', description: 'From observed remaining-context or assistant usage data' },
      { field: 'tools', source: 'observed', description: 'Compact counts of observed tool calls' },
      { field: 'relevantFiles', source: 'observed', description: 'Recent file paths from observed tool inputs' },
      { field: 'usage', source: 'observed', description: 'Aggregated assistant usage records' },

      { field: 'action', source: 'derived', description: 'From tool + file' },
      { field: 'path', source: 'derived', description: 'From file path' },

      { field: 'priority', source: 'derived', description: 'Attention priority from observed phase and explicit heuristic signals' },
      { field: 'hue', source: 'inferred', description: 'Hash of sessionId' },
      { field: 'mark', source: 'inferred', description: 'Hash of sessionId' },
      { field: 'branch', source: 'observed', description: 'From transcript metadata or git working tree' },
      { field: 'model', source: 'observed', description: 'From assistant model metadata' },
      { field: 'effort', source: 'observed', description: 'From assistant metadata or the active Claude settings value' },
      { field: 'delay', source: 'inferred', description: 'Random for animation' },

      { field: 'edit', source: 'unavailable', description: 'Would need diff analysis' },
      { field: 'cost', source: 'unavailable', description: 'Would need API tracking' },
      { field: 'message', source: 'observed', description: 'Latest meaningful assistant text block' },
      { field: 'progress', source: 'unavailable', description: 'Not observable' },
      { field: 'filesGiven', source: 'unavailable', description: 'Not observable' },
      { field: 'foundFiles', source: 'unavailable', description: 'Not observable' },
      { field: 'permission', source: 'observed', description: 'Permission-related tool-result evidence from the transcript' },
      { field: 'signal', source: 'derived', description: 'Explicitly heuristic repeated-tool, outside-project, or busy-without-activity rule' }
    ]
  }
}
