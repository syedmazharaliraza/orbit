/**
 * PerSessionObserver - Aggregates data for a single Claude Code session
 *
 * Responsibilities:
 * - Coordinate SessionMetadataWatcher, HistoryReader, and ConversationTranscriptTailer
 * - Aggregate data from all sources into ClaudeSessionState
 * - Emit state updates when any source provides new information
 * - Handle component failures gracefully
 */

import { EventEmitter } from 'node:events'
import { SessionMetadataWatcher } from './SessionMetadataWatcher'
import { HistoryReader } from './HistoryReader'
import { ConversationTranscriptTailer, TranscriptEventParser } from './ConversationTranscriptTailer'
import { SessionActivityStateMachine, type ObservedTool } from './SessionActivityStateMachine'
import { ClaudeSettingsReader } from './ClaudeSettingsReader'
import type {
  ClaudeSessionState,
  DiscoveredSession,
  SessionMetadata,
  TranscriptEvent,
  LastPromptEvent,
  AssistantMessageEvent,
  UserMessageEvent,
  TokenReminderAttachment,
  Activity
} from './types'


export class PerSessionObserver extends EventEmitter {
  private metadataWatcher: SessionMetadataWatcher
  private transcriptTailer: ConversationTranscriptTailer | null = null
  private state: ClaudeSessionState
  private activityBuffer: Activity[] = []
  private maxActivityHistory = 20
  private historyReader: HistoryReader
  private debounceTimeout: NodeJS.Timeout | null = null
  private activityState: SessionActivityStateMachine
  private settingsReader = new ClaudeSettingsReader()
  private effortSource: 'configured' | 'observed' | undefined
  private toolCounts = new Map<string, { count: number; lastUsedAt: number }>()
  private relevantFiles: string[] = []

  constructor(
    session: DiscoveredSession,
    historyReader: HistoryReader,
    private useFilesystemWatching = true,
    maxActivityHistory = 20
  ) {
    super()
    this.maxActivityHistory = Math.max(1, maxActivityHistory)

    // Initialize state from discovered session
    this.state = {
      pid: session.pid,
      sessionId: session.sessionId,
      name: session.name,
      status: session.status,
      cwd: session.cwd,
      startedAt: session.startedAt,
      kind: session.kind,
      activityPhase: session.status === 'busy' ? 'starting' : session.status === 'waiting' ? 'waiting' : 'idle'
    }

    this.historyReader = historyReader
    this.activityState = new SessionActivityStateMachine(session.status)
    this.metadataWatcher = new SessionMetadataWatcher(session.pid, useFilesystemWatching)
    this.transcriptTailer = new ConversationTranscriptTailer(
      session.sessionId,
      session.cwd,
      useFilesystemWatching
    )

    this.setupEventHandlers()
  }

  /**
   * Start observing this session
   */
  async start(): Promise<void> {
    // Start metadata watching
    await this.metadataWatcher.start()

    // Load initial task from history
    const task = await this.historyReader.getTaskForSession(this.state.sessionId)
    if (task) {
      this.state.initialTask = task
      this.state.promptContext = task
      this.emitStateUpdate()
    }

    // Branch is not part of discovery. Read the current repository metadata
    // once as a fallback; transcript events remain authoritative when present.

    // Start transcript tailing
    if (this.transcriptTailer) {
      await this.transcriptTailer.start()
    }

    await this.applyConfiguredEffort()

    // Emit initial state
    this.emitStateUpdate()
  }

  /**
   * Stop observing and clean up
   */
  stop(): void {
    this.metadataWatcher.stop()
    if (this.transcriptTailer) {
      this.transcriptTailer.stop()
    }

    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
      this.debounceTimeout = null
    }

    this.removeAllListeners()
  }

  /**
   * Set up event handlers for all data sources
   */
  private setupEventHandlers(): void {
    // Metadata updates
    this.metadataWatcher.on('metadata-updated', (metadata: SessionMetadata) => {
      this.handleMetadataUpdate(metadata)
    })

    this.metadataWatcher.on('session-ended', () => {
      this.emit('session-ended', this.state.sessionId)
      this.stop()
    })

    this.metadataWatcher.on('error', (error: Error) => {
      console.error(`[PerSessionObserver] Metadata error for ${this.state.sessionId}:`, error)
    })

    // Transcript events
    if (this.transcriptTailer) {
      this.transcriptTailer.on('transcript-event', (event: TranscriptEvent) => {
        this.handleTranscriptEvent(event)
      })
    }
  }

  /**
   * Handle metadata updates
   */
  private handleMetadataUpdate(metadata: SessionMetadata): void {
    // Update state with new metadata
    this.state.status = metadata.status
    this.state.waitingFor = metadata.waitingFor
    this.state.statusUpdatedAt = metadata.statusUpdatedAt
    this.state.version = metadata.version
    this.state.name = metadata.name
    this.activityState.onStatus(metadata.status)
    this.syncActivityState()
    this.applyWaitingMetadata()

    this.emitStateUpdate()
  }

  /** Apply a discovery status immediately; metadata may lag or be unavailable. */
  updateDiscoverySession(session: DiscoveredSession): void {
    this.state.status = session.status
    this.state.waitingFor = session.waitingFor
    this.state.name = session.name
    this.state.cwd = session.cwd
    this.activityState.onStatus(session.status)
    this.syncActivityState()
    this.applyWaitingMetadata()
    this.emitStateUpdate()
  }

  /**
   * Handle transcript events
   */
  private handleTranscriptEvent(event: TranscriptEvent): void {
    if (event.gitBranch) this.state.gitBranch = event.gitBranch
    if (typeof event.version === 'string') this.state.version = event.version

    switch (event.type) {
      case 'last-prompt':
        this.handleLastPrompt(event as LastPromptEvent)
        break

      case 'assistant':
        this.handleAssistantMessage(event as AssistantMessageEvent)
        break

      case 'user':
        this.handleUserMessage(event as UserMessageEvent)
        break

      case 'attachment':
        this.handleAttachment(event as TokenReminderAttachment)
        break

      default:
        // Ignore other event types for now
        break
    }
  }

  /**
   * Handle last-prompt events (task updates)
   */
  private handleLastPrompt(event: LastPromptEvent): void {
    const task = TranscriptEventParser.extractTask(event)
    if (task) {
      this.state.lastPrompt = task
      this.state.promptContext = task
      this.state.lastActivityAt = this.eventTime(event.timestamp)
      // Transcript replay includes the latest prompt even when Claude has
      // already reached its authoritative metadata-level waiting state. Do
      // not let that historical event downgrade `waiting` to `processing`.
      if (this.state.status === 'waiting') this.activityState.onStatus('waiting')
      else this.activityState.onPrompt()
      this.syncActivityState()
      this.emitStateUpdate()
    }
  }

  /**
   * Handle assistant messages (tool use)
   */
  private handleAssistantMessage(event: AssistantMessageEvent): void {
    const toolUses = TranscriptEventParser.extractToolUse(event)
    const assistantText = TranscriptEventParser.extractAssistantText(event)
    const usage = TranscriptEventParser.extractUsage(event)
    const model = TranscriptEventParser.model(event)
    const effort = TranscriptEventParser.effort(event)
    if (model) this.state.model = model
    if (effort) {
      this.state.effort = effort
      this.effortSource = 'observed'
    }
    if (!effort) void this.applyConfiguredEffort()
    if (usage) this.mergeUsage(usage)
    const observedTools: ObservedTool[] = toolUses.map(tool => ({
      id: tool.id,
      name: tool.tool,
      file: tool.file,
      operation: tool.operation,
      command: tool.command,
      question: tool.question
    }))

    this.activityState.onAssistantActivity(
      observedTools,
      Boolean(assistantText) || TranscriptEventParser.hasThinking(event),
      event.message.stop_reason
    )

    this.state.lastActivityAt = this.eventTime(event.timestamp)
    if (assistantText) this.state.lastAssistantMessage = assistantText

    if (toolUses.length > 0) {
      // Keep every tool from a streamed assistant message. The UI receives
      // concise labels only; raw input payloads never leave this process.
      for (const tool of toolUses) this.recordTool(tool.tool, tool.file, this.eventTime(event.timestamp))
      const latest = toolUses[toolUses.length - 1]

      this.state.currentTool = latest.tool
      this.state.currentFile = latest.file
      this.state.fileOperation = latest.operation

      for (const tool of toolUses) {
        this.addActivity({
          time: this.formatTime(event.timestamp),
          text: TranscriptEventParser.describeTool(tool),
          current: tool === latest,
          observedAt: this.eventTime(event.timestamp)
        })
      }
    } else if (event.message.stop_reason === 'end_turn') {
      this.addActivity({ time: this.formatTime(event.timestamp), text: 'waiting for user response', current: true, observedAt: this.eventTime(event.timestamp) })
    } else if (assistantText) {
      this.state.lastAssistantMessage = assistantText
      this.addActivity({ time: this.formatTime(event.timestamp), text: `assistant · ${assistantText}`, current: true, observedAt: this.eventTime(event.timestamp) })
    }

    this.syncActivityState()
    this.emitStateUpdate()
  }

  /** Tool results close an active call; errors which explicitly mention an
   * approval/rejection are surfaced as an observed permission-related state. */
  private handleUserMessage(event: UserMessageEvent): void {
    const toolResults = TranscriptEventParser.extractToolResults(event)

    if (toolResults.length === 0) {
      const prompt = TranscriptEventParser.extractUserPrompt(event)
      if (prompt) {
        this.state.lastPrompt = prompt
        this.state.promptContext = prompt
        this.state.lastActivityAt = this.eventTime(event.timestamp)
        if (this.state.status === 'waiting') this.activityState.onStatus('waiting')
        else this.activityState.onPrompt()
        this.addActivity({ time: this.formatTime(event.timestamp), text: `prompt · ${prompt}`, current: true, observedAt: this.eventTime(event.timestamp) })
        this.syncActivityState()
        this.emitStateUpdate()
      }
      return
    }

    for (const result of toolResults) {
      const permissionText = this.permissionSignal(result.content, result.is_error, event.toolUseResult)
      const observedAt = this.eventTime(event.timestamp)
      const completed = this.activityState.onToolFinished(result.tool_use_id, permissionText, observedAt)
      this.state.lastActivityAt = observedAt
      const description = completed
        ? `finished · ${completed.name.toLowerCase()}${completed.file ? ` · ${this.shortFile(completed.file)}` : ''}`
        : 'tool finished'
      this.addActivity({ time: this.formatTime(event.timestamp), text: description, current: true, observedAt })
    }

    this.syncActivityState()
    this.emitStateUpdate()
  }

  /**
   * Handle attachment events (tokens, etc.)
   */
  private handleAttachment(event: TokenReminderAttachment): void {
    const attachment = event.attachment as unknown as Record<string, unknown>
    if (attachment.type === 'model') {
      const identity = attachment.identity as Record<string, unknown> | undefined
      if (typeof identity?.modelId === 'string') this.state.model = identity.modelId
      void this.applyConfiguredEffort()
      this.emitStateUpdate()
      return
    }

    if (attachment.type === 'total_tokens_reminder') {
      const tokens = TranscriptEventParser.extractTokens(event)
      if (tokens) {
        this.state.tokensRemaining = tokens.remaining
        this.emitStateUpdate()
      }
    }
  }

  /**
   * Add an activity to the buffer
   */
  private addActivity(activity: Activity): void {
    // Mark previous activities as not current
    for (const act of this.activityBuffer) {
      act.current = false
    }

    // Add new activity
    this.activityBuffer.push(activity)

    // Trim to max size
    if (this.activityBuffer.length > this.maxActivityHistory) {
      this.activityBuffer.shift()
    }

    // Update state
    this.state.activity = [...this.activityBuffer]
  }

  private syncActivityState(): void {
    const snapshot = this.activityState.snapshot()
    this.state.activityPhase = snapshot.phase
    this.state.toolLifecycle = snapshot.toolLifecycle
    this.state.permission = snapshot.permission
    this.state.question = snapshot.question
    this.state.lastToolFinishedAt = snapshot.lastToolFinishedAt
  }

  private applyWaitingMetadata(): void {
    if (!this.state.waitingFor || !/permission|approval|approve|allow/i.test(this.state.waitingFor)) return
    if (!this.state.permission) {
      this.state.permission = {
        command: this.state.currentTool || this.state.waitingFor,
        question: 'Claude Code is waiting for your permission to continue.'
      }
    }
  }

  private eventTime(timestamp: string | undefined): number {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  private formatTime(timestamp: string | undefined): string {
    const date = new Date(this.eventTime(timestamp))
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  }

  private permissionSignal(
    content: string | { type: string; text?: string }[],
    isError?: boolean,
    toolUseResult?: unknown
  ): string | undefined {
    if (!isError && !toolUseResult) return undefined
    const message = [
      typeof content === 'string' ? content : content.map(item => item.text || '').join(' '),
      typeof toolUseResult === 'string' ? toolUseResult : JSON.stringify(toolUseResult || '')
    ].join(' ').toLowerCase()

    return /permission|approval|approve|denied|rejected|not allowed/.test(message) ? message : undefined
  }

  private recordTool(name: string, file: string | undefined, observedAt: number): void {
    const previous = this.toolCounts.get(name)
    this.toolCounts.set(name, { count: (previous?.count || 0) + 1, lastUsedAt: observedAt })
    if (file) {
      this.relevantFiles = [file, ...this.relevantFiles.filter(item => item !== file)].slice(0, 12)
    }
    this.state.tools = [...this.toolCounts.entries()]
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .slice(0, 12)
      .map(([name, value]) => ({ name, count: value.count, lastUsedAt: value.lastUsedAt }))
    this.state.relevantFiles = [...this.relevantFiles]
  }

  private mergeUsage(next: NonNullable<ClaudeSessionState['usage']>): void {
    const previous = this.state.usage
    this.state.usage = {
      inputTokens: (previous?.inputTokens || 0) + next.inputTokens,
      outputTokens: (previous?.outputTokens || 0) + next.outputTokens,
      cacheReadInputTokens: (previous?.cacheReadInputTokens || 0) + (next.cacheReadInputTokens || 0),
      cacheCreationInputTokens: (previous?.cacheCreationInputTokens || 0) + (next.cacheCreationInputTokens || 0),
      thinkingTokens: (previous?.thinkingTokens || 0) + (next.thinkingTokens || 0),
      totalTokens: (previous?.totalTokens || 0) + next.totalTokens,
      turnCount: (previous?.turnCount || 0) + next.turnCount,
      lastInputTokens: next.lastInputTokens,
      lastOutputTokens: next.lastOutputTokens
    }
  }

  private async applyConfiguredEffort(): Promise<void> {
    if (this.effortSource === 'observed') return
    if (!this.state.model) {
      const defaultModel = await this.settingsReader.getDefaultModel()
      if (defaultModel && !this.state.model) this.state.model = defaultModel
    }
    if (!this.state.model) return
    const effort = await this.settingsReader.getEffort(this.state.model)
    const effortSource = this.effortSource as 'configured' | 'observed' | undefined
    if (!effort || effortSource === 'observed') return
    this.state.effort = effort
    this.effortSource = 'configured'
    this.emitStateUpdate()
  }

  private shortFile(file: string): string {
    return file.split('/').pop() || file
  }

  /**
   * Publish a compact, batched state update. A 150ms window combines a burst
   * of transcript records while keeping live activity perceptibly immediate.
   */
  private emitStateUpdate(): void {
    if (this.debounceTimeout) {
      // Update pending - will include latest state
      return
    }

    this.debounceTimeout = setTimeout(() => {
      this.debounceTimeout = null
      this.emit('state-updated', this.getState())
    }, 150)
  }

  /**
   * Get current session state
   */
  getState(): ClaudeSessionState {
    return { ...this.state }
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.state.sessionId
  }
}
