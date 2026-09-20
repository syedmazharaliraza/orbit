/**
 * HookEventProcessor - Processes hook events for a single Claude Code session
 *
 * Responsibilities:
 * - Maintain ClaudeSessionState for one session
 * - Process incoming hook events and update state accordingly
 * - Drive SessionActivityStateMachine
 * - Track tool counts, relevant files, activity buffer
 * - Debounce state emissions (150ms)
 * - Emit state-updated events
 */

import { EventEmitter } from 'node:events'
import { SessionActivityStateMachine, type ObservedTool } from './SessionActivityStateMachine'
import type {
  ClaudeSessionState,
  HookEventPayload,
  Activity,
  ClaudeSessionStatus,
  ObservedQuestionRequest,
  ObservedPermissionRequest
} from './types'

export class HookEventProcessor extends EventEmitter {
  private state: ClaudeSessionState
  private activityState: SessionActivityStateMachine
  private activityBuffer: Activity[] = []
  private maxActivityHistory = 20
  private toolCounts = new Map<string, { count: number; lastUsedAt: number }>()
  private relevantFiles: string[] = []
  private debounceTimeout: NodeJS.Timeout | null = null

  constructor(sessionId: string, initialState: Partial<ClaudeSessionState> = {}) {
    super()

    // Initialize state with defaults
    this.state = {
      pid: 0,
      sessionId,
      name: initialState.name || 'Unknown',
      status: initialState.status || 'idle',
      cwd: initialState.cwd || '~',
      startedAt: initialState.startedAt || Date.now(),
      kind: initialState.kind || 'unknown',
      activityPhase: 'starting',
      ...initialState
    }

    this.activityState = new SessionActivityStateMachine(this.state.status)
  }

  /**
   * Process a hook event and update state
   */
  processEvent(eventType: string, payload: HookEventPayload): void {
    const timestamp = Date.now()

    switch (eventType) {
      case 'SessionStart':
        this.handleSessionStart(payload, timestamp)
        break

      case 'SessionEnd':
      case 'Stop':
        this.handleSessionEnd(payload, timestamp)
        break

      case 'PreToolUse':
        this.handlePreToolUse(payload, timestamp)
        break

      case 'PostToolUse':
        this.handlePostToolUse(payload, timestamp)
        break

      case 'UserPromptSubmit':
        this.handleUserPromptSubmit(payload, timestamp)
        break

      case 'PermissionRequest':
        this.handlePermissionRequest(payload, timestamp)
        break

      case 'PermissionDenied':
        this.handlePermissionDenied(payload, timestamp)
        break

      case 'Elicitation':
        this.handleElicitation(payload, timestamp)
        break

      case 'ElicitationResult':
        this.handleElicitationResult(payload, timestamp)
        break

      case 'PostModelSwitch':
        this.handlePostModelSwitch(payload, timestamp)
        break

      case 'PreCompact':
        this.handlePreCompact(payload, timestamp)
        break

      case 'PostCompact':
        this.handlePostCompact(payload, timestamp)
        break

      case 'MessageDisplay':
        this.handleMessageDisplay(payload, timestamp)
        break

      case 'SubagentStart':
        this.handleSubagentStart(payload, timestamp)
        break

      case 'SubagentStop':
        this.handleSubagentStop(payload, timestamp)
        break

      default:
        console.log(`[HookEventProcessor] Unknown event type: ${eventType}`)
        break
    }
  }

  private handleSessionStart(payload: HookEventPayload, timestamp: number): void {
    // SessionStart payload should contain pid, name, cwd, kind, etc.
    if (payload.pid) this.state.pid = payload.pid as number
    if (payload.name) this.state.name = payload.name as string
    if (payload.cwd) this.state.cwd = payload.cwd as string
    if (payload.kind) this.state.kind = payload.kind as string
    if (payload.startedAt) this.state.startedAt = payload.startedAt as number
    if (payload.version) this.state.version = payload.version as string

    this.state.status = 'busy'
    this.state.activityPhase = 'starting'
    this.state.lastActivityAt = timestamp

    this.activityState.onStatus('busy')
    this.syncActivityState()
    this.emitStateUpdate()
  }

  private handleSessionEnd(payload: HookEventPayload, timestamp: number): void {
    this.state.status = 'idle'
    this.state.lastActivityAt = timestamp
    this.emit('session-ended', this.state.sessionId)
  }

  private handlePreToolUse(payload: HookEventPayload, timestamp: number): void {
    const toolName = payload.tool_name as string | undefined
    const toolInput = payload.tool_input as Record<string, unknown> | undefined

    if (!toolName) return

    // Extract file path from tool input
    const filePath = this.extractFilePath(toolInput)
    const operation = this.inferOperation(toolName, toolInput)

    this.state.currentTool = toolName
    this.state.currentFile = filePath
    this.state.fileOperation = operation
    this.state.lastActivityAt = timestamp

    // Create observed tool for activity state machine
    const observedTool: ObservedTool = {
      id: `${toolName}-${timestamp}`,
      name: toolName,
      file: filePath,
      operation,
      command: this.extractCommand(toolInput)
    }

    this.activityState.onAssistantActivity([observedTool], false, null)
    this.syncActivityState()

    const description = this.describeToolStart(toolName, filePath)
    this.addActivity({
      time: this.formatTime(timestamp),
      text: description,
      current: true,
      observedAt: timestamp
    })

    this.emitStateUpdate()
  }

  private handlePostToolUse(payload: HookEventPayload, timestamp: number): void {
    const toolName = payload.tool_name as string | undefined
    const toolInput = payload.tool_input as Record<string, unknown> | undefined
    const toolResponse = payload.tool_response as Record<string, unknown> | undefined

    if (!toolName) return

    // Record tool usage
    const filePath = this.extractFilePath(toolInput)
    this.recordTool(toolName, filePath, timestamp)

    // Update state
    this.state.toolLifecycle = 'finished'
    this.state.lastActivityAt = timestamp
    this.state.lastToolFinishedAt = timestamp

    // Extract result/error from tool response
    if (toolResponse) {
      const resultText = this.extractToolResult(toolResponse)
      if (resultText) {
        this.state.lastToolResult = resultText
      }
    }

    // Notify activity state machine
    const toolId = `${toolName}-${timestamp}`
    this.activityState.onToolFinished(toolId, undefined, timestamp)
    this.syncActivityState()

    const description = `finished · ${toolName.toLowerCase()}${filePath ? ` · ${this.shortFile(filePath)}` : ''}`
    this.addActivity({
      time: this.formatTime(timestamp),
      text: description,
      current: true,
      observedAt: timestamp
    })

    this.emitStateUpdate()
  }

  private handleUserPromptSubmit(payload: HookEventPayload, timestamp: number): void {
    const prompt = payload.prompt as string | undefined

    if (prompt) {
      this.state.lastPrompt = prompt
      this.state.promptContext = prompt
      this.state.lastActivityAt = timestamp

      // Set initial task if this is the first prompt
      if (!this.state.initialTask) {
        this.state.initialTask = prompt
      }

      // Update activity state
      if (this.state.status === 'waiting') {
        this.activityState.onStatus('waiting')
      } else {
        this.activityState.onPrompt()
      }

      this.syncActivityState()

      this.addActivity({
        time: this.formatTime(timestamp),
        text: `prompt · ${this.truncate(prompt, 80)}`,
        current: true,
        observedAt: timestamp
      })

      this.emitStateUpdate()
    }
  }

  private handlePermissionRequest(payload: HookEventPayload, timestamp: number): void {
    const command = (payload.command as string) || this.state.currentTool || 'unknown'
    const question =
      (payload.question as string) || 'Claude Code is waiting for your permission to continue.'

    this.state.permission = { command, question }
    this.state.activityPhase = 'permission'
    this.state.lastActivityAt = timestamp

    this.addActivity({
      time: this.formatTime(timestamp),
      text: `permission · ${command}`,
      current: true,
      observedAt: timestamp
    })

    this.emitStateUpdate()
  }

  private handlePermissionDenied(payload: HookEventPayload, timestamp: number): void {
    // Clear or update permission state
    this.state.permission = undefined
    this.state.lastActivityAt = timestamp

    this.addActivity({
      time: this.formatTime(timestamp),
      text: 'permission denied',
      current: true,
      observedAt: timestamp
    })

    this.syncActivityState()
    this.emitStateUpdate()
  }

  private handleElicitation(payload: HookEventPayload, timestamp: number): void {
    // Extract questions from tool_input
    const toolInput = payload.tool_input as { questions?: unknown[] } | undefined
    const questions = toolInput?.questions

    if (questions && Array.isArray(questions)) {
      this.state.question = {
        questions: questions.map((q) => ({
          question: (q as { question?: string }).question || '',
          header: (q as { header?: string }).header,
          options: (q as { options?: { label: string; description?: string }[] }).options || [],
          multiSelect: (q as { multiSelect?: boolean }).multiSelect
        }))
      } as ObservedQuestionRequest

      this.state.activityPhase = 'waiting'
      this.state.lastActivityAt = timestamp

      this.addActivity({
        time: this.formatTime(timestamp),
        text: 'asking question',
        current: true,
        observedAt: timestamp
      })

      this.emitStateUpdate()
    }
  }

  private handleElicitationResult(payload: HookEventPayload, timestamp: number): void {
    // Clear question state
    this.state.question = undefined
    this.state.lastActivityAt = timestamp
    this.syncActivityState()
    this.emitStateUpdate()
  }

  private handlePostModelSwitch(payload: HookEventPayload, timestamp: number): void {
    const model = payload.model as string | undefined
    if (model) {
      this.state.model = model
      this.state.lastActivityAt = timestamp

      this.addActivity({
        time: this.formatTime(timestamp),
        text: `model · ${model}`,
        current: false,
        observedAt: timestamp
      })

      this.emitStateUpdate()
    }
  }

  private handlePreCompact(payload: HookEventPayload, timestamp: number): void {
    // Signal that context is filling up
    this.state.lastActivityAt = timestamp
    this.addActivity({
      time: this.formatTime(timestamp),
      text: 'compacting context',
      current: false,
      observedAt: timestamp
    })
  }

  private handlePostCompact(payload: HookEventPayload, timestamp: number): void {
    // Update tokens remaining if available
    const tokensRemaining = payload.tokensRemaining as number | undefined
    if (tokensRemaining !== undefined) {
      this.state.tokensRemaining = tokensRemaining
      this.emitStateUpdate()
    }
  }

  private handleMessageDisplay(payload: HookEventPayload, timestamp: number): void {
    const message = payload.message as string | undefined
    if (message) {
      this.state.lastAssistantMessage = message
      this.state.activityPhase = 'assistant'
      this.state.lastActivityAt = timestamp

      this.addActivity({
        time: this.formatTime(timestamp),
        text: `assistant · ${this.truncate(message, 60)}`,
        current: true,
        observedAt: timestamp
      })

      this.emitStateUpdate()
    }
  }

  private handleSubagentStart(payload: HookEventPayload, timestamp: number): void {
    // Track subagent awareness (could be used for future features)
    this.state.lastActivityAt = timestamp
  }

  private handleSubagentStop(payload: HookEventPayload, timestamp: number): void {
    // Track subagent awareness (could be used for future features)
    this.state.lastActivityAt = timestamp
  }

  // ============================================================================
  // Utility Methods (ported from PerSessionObserver)
  // ============================================================================

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

  private recordTool(name: string, file: string | undefined, observedAt: number): void {
    const previous = this.toolCounts.get(name)
    this.toolCounts.set(name, { count: (previous?.count || 0) + 1, lastUsedAt: observedAt })

    if (file) {
      this.relevantFiles = [file, ...this.relevantFiles.filter((item) => item !== file)].slice(
        0,
        12
      )
    }

    this.state.tools = [...this.toolCounts.entries()]
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .slice(0, 12)
      .map(([name, value]) => ({ name, count: value.count, lastUsedAt: value.lastUsedAt }))

    this.state.relevantFiles = [...this.relevantFiles]
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  }

  private shortFile(file: string): string {
    return file.split('/').pop() || file
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength - 3) + '...'
  }

  private extractFilePath(toolInput: Record<string, unknown> | undefined): string | undefined {
    if (!toolInput) return undefined
    return (
      (toolInput.file_path as string) ||
      (toolInput.path as string) ||
      (toolInput.notebook_path as string)
    )
  }

  private extractCommand(toolInput: Record<string, unknown> | undefined): string | undefined {
    if (!toolInput) return undefined
    return toolInput.command as string | undefined
  }

  private inferOperation(
    toolName: string,
    toolInput: Record<string, unknown> | undefined
  ): 'EDITING' | 'READING' | undefined {
    if (toolName === 'Edit' || toolName === 'Write') return 'EDITING'
    if (toolName === 'Read') return 'READING'
    return undefined
  }

  private describeToolStart(toolName: string, filePath: string | undefined): string {
    const name = toolName.toLowerCase()
    if (filePath) {
      return `${name} · ${this.shortFile(filePath)}`
    }
    return name
  }

  private extractToolResult(toolResponse: Record<string, unknown>): string | undefined {
    // Tool responses may have different structures depending on the tool
    if (typeof toolResponse.result === 'string') {
      return this.truncate(toolResponse.result, 200)
    }
    if (typeof toolResponse.error === 'string') {
      return this.truncate(toolResponse.error, 200)
    }
    return undefined
  }

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

  // ============================================================================
  // Public API
  // ============================================================================

  getState(): ClaudeSessionState {
    return { ...this.state }
  }

  stop(): void {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
      this.debounceTimeout = null
    }

    this.removeAllListeners()
  }
}
