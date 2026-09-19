/**
 * Turns Claude Code's fine-grained transcript events into a small, stable set
 * of worker phases. It intentionally does not emit on its own; callers batch
 * state publication so a tool_use/tool_result/next assistant message sequence
 * is rendered as one coherent transition rather than a flicker.
 */

import type {
  ClaudeActivityPhase,
  ObservedPermissionRequest,
  ObservedQuestionRequest,
  ToolLifecycle,
  ClaudeSessionStatus
} from './types'

export type ObservedTool = {
  id: string
  name: string
  file?: string
  operation?: 'EDITING' | 'READING'
  command?: string
  question?: ObservedQuestionRequest
}

export class SessionActivityStateMachine {
  private phase: ClaudeActivityPhase
  private toolLifecycle: ToolLifecycle | undefined
  private activeTools = new Map<string, ObservedTool>()
  private latestTool: ObservedTool | undefined
  private waitingForUser = false
  private permission: ObservedPermissionRequest | undefined
  private question: ObservedQuestionRequest | undefined
  private lastToolFinishedAt: number | undefined

  constructor(initialStatus: ClaudeSessionStatus) {
    this.phase = initialStatus === 'busy' ? 'starting' : initialStatus === 'waiting' ? 'waiting' : 'idle'
    this.waitingForUser = initialStatus === 'waiting'
  }

  onStatus(status: ClaudeSessionStatus): void {
    if (status === 'busy') {
      // A newly active session is a reliable resume signal. Clear a prior
      // permission/wait indication only when Claude actually starts again.
      this.waitingForUser = false
      this.permission = undefined
      const active = this.getLatestActiveTool()
      if (active?.question) {
        this.setActiveToolPhase(active)
        return
      }
      if (active) {
        this.setActiveToolPhase(active)
      } else if (this.phase === 'waiting' || this.phase === 'permission' || this.phase === 'idle' || this.phase === 'starting') {
        this.phase = 'processing'
        this.toolLifecycle = undefined
      }
      return
    }

    if (this.permission) {
      this.phase = 'permission'
    } else if (status === 'waiting' || this.waitingForUser) {
      this.waitingForUser = true
      this.phase = 'waiting'
    } else {
      this.phase = 'idle'
      this.toolLifecycle = undefined
    }
  }

  onPrompt(): void {
    this.waitingForUser = false
    this.permission = undefined
    this.question = undefined
    this.phase = 'processing'
    this.toolLifecycle = undefined
  }

  onAssistantActivity(tools: ObservedTool[], hasAssistantContent: boolean, stopReason?: string | null): void {
    if (tools.length > 0) {
      for (const tool of tools) this.activeTools.set(tool.id, tool)
      this.latestTool = tools[tools.length - 1]
      this.waitingForUser = false
      this.permission = undefined
      this.setActiveToolPhase(this.latestTool)
      return
    }

    if (stopReason === 'end_turn') {
      // This is the strongest transcript signal that Claude has yielded the
      // turn to its user. Metadata will later confirm idle, but waiting now
      // makes the UI react without a polling delay.
      this.activeTools.clear()
      this.waitingForUser = true
      this.phase = 'waiting'
      this.toolLifecycle = undefined
      return
    }

    if (hasAssistantContent && this.activeTools.size === 0) {
      this.waitingForUser = false
      this.permission = undefined
      this.phase = 'assistant'
      this.toolLifecycle = undefined
    }
  }

  onToolFinished(toolUseId: string, permissionText?: string, observedAt = Date.now()): ObservedTool | undefined {
    const completed = this.activeTools.get(toolUseId)
    if (completed) {
      this.activeTools.delete(toolUseId)
      this.latestTool = completed
      this.question = undefined
    }

    if (permissionText) {
      const command = completed?.command || completed?.file || completed?.name || 'tool action'
      this.permission = {
        command,
        question: 'Claude Code needs your approval to continue with {command}.'
      }
      this.waitingForUser = true
      this.phase = 'permission'
      this.toolLifecycle = undefined
      return completed
    }

    if (completed) this.lastToolFinishedAt = observedAt

    if (this.activeTools.size > 0) {
      this.setActiveToolPhase(this.getLatestActiveTool()!)
    } else {
      this.phase = 'tool-finished'
      this.toolLifecycle = 'finished'
    }

    return completed
  }

  snapshot(): {
    phase: ClaudeActivityPhase
    toolLifecycle?: ToolLifecycle
    permission?: ObservedPermissionRequest
    question?: ObservedQuestionRequest
    lastToolFinishedAt?: number
  } {
    return {
      phase: this.phase,
      toolLifecycle: this.toolLifecycle,
      permission: this.permission && { ...this.permission },
      question: this.question && { questions: this.question.questions.map(item => ({ ...item, options: item.options.map(option => ({ ...option })) })) },
      lastToolFinishedAt: this.lastToolFinishedAt
    }
  }

  private getLatestActiveTool(): ObservedTool | undefined {
    return [...this.activeTools.values()].at(-1)
  }

  private setActiveToolPhase(tool: ObservedTool): void {
    this.toolLifecycle = 'active'
    if (tool.question) {
      this.question = tool.question
      this.waitingForUser = true
      this.phase = 'waiting'
      return
    }
    if (tool.operation === 'EDITING') this.phase = 'editing'
    else if (tool.operation === 'READING') this.phase = 'reading'
    else this.phase = 'tool'
  }
}
