/**
 * Type definitions for Claude Code session observation
 * Stage 6: Read-only observation of local Claude Code sessions
 */

import type { Worker } from '../../renderer/src/crew'

export type Activity = { time: string; text: string; current?: boolean; observedAt?: number }
export type ClaudeSessionStatus = 'busy' | 'idle' | 'waiting'

export interface ObservedToolSummary {
  name: string
  count: number
  lastUsedAt: number
}

export interface ObservedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  thinkingTokens?: number
  totalTokens: number
  turnCount: number
  lastInputTokens?: number
  lastOutputTokens?: number
}

// ============================================================================
// Discovery Types (from `claude agents --json`)
// ============================================================================

export interface DiscoveredSession {
  pid: number
  cwd: string
  kind: string
  startedAt: number
  sessionId: string
  name: string
  status: ClaudeSessionStatus
  waitingFor?: string
}

export type SessionDiscoveryEventType = 'added' | 'removed' | 'status-changed'

export interface SessionDiscoveryEvent {
  type: SessionDiscoveryEventType
  session: DiscoveredSession
  previousStatus?: ClaudeSessionStatus
}

// ============================================================================
// Session Metadata Types (from ~/.claude/sessions/<pid>.json)
// ============================================================================

export interface SessionMetadata extends DiscoveredSession {
  version: string
  statusUpdatedAt: number
  messagingSocketPath: string
  peerProtocol: number
  peerFeatures: string[]
  procStart: string
  entrypoint: string
  pidDomain: string
  waitingFor?: string
}

// ============================================================================
// Question/Elicitation Types (used in hook events and session state)
// ============================================================================

export interface ObservedQuestionOption {
  label: string
  description?: string
}

export interface ObservedQuestion {
  question: string
  header?: string
  options: ObservedQuestionOption[]
  multiSelect?: boolean
}

export interface ObservedQuestionRequest {
  questions: ObservedQuestion[]
}

// ============================================================================
// Hook Event Types (from Claude Code hooks via HTTP POST)
// ============================================================================

/**
 * Hook event payload received from Claude Code hooks.
 * Each hook POST contains the session_id and event-specific fields.
 */
export interface HookEventPayload {
  session_id: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: Record<string, unknown>
  [key: string]: unknown // event-specific fields
}

/**
 * Hook event types that ORBIT subscribes to.
 */
export type OrbitHookEventType =
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'PostModelSwitch'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'MessageDisplay'

// ============================================================================
// Aggregated Session State
// ============================================================================

/**
 * A stable, user-facing interpretation of the transcript. This is deliberately
 * coarser than Claude's event stream: several raw events may describe one UI
 * action, and a phase is retained until a meaningful transition occurs.
 */
export type ClaudeActivityPhase =
  | 'starting'
  | 'processing'
  | 'assistant'
  | 'tool'
  | 'reading'
  | 'editing'
  | 'tool-finished'
  | 'waiting'
  | 'permission'
  | 'idle'

export type ToolLifecycle = 'active' | 'finished'

export interface ObservedPermissionRequest {
  command: string
  question: string
}

export interface ClaudeSessionState {
  // Core identity (from discovery)
  pid: number
  sessionId: string
  name: string
  status: ClaudeSessionStatus
  cwd: string
  startedAt: number
  kind: string
  waitingFor?: string

  // From session metadata file (optional)
  version?: string
  statusUpdatedAt?: number

  // From history.jsonl (optional)
  initialTask?: string

  // From transcript tailing (optional)
  lastPrompt?: string
  currentTool?: string
  currentFile?: string
  fileOperation?: 'EDITING' | 'READING'
  activity?: Activity[]
  tools?: ObservedToolSummary[]
  relevantFiles?: string[]
  tokensRemaining?: number
  tokensTotal?: number
  usage?: ObservedUsage
  gitBranch?: string
  model?: string
  effort?: string
  lastToolResult?: string
  activityPhase: ClaudeActivityPhase
  toolLifecycle?: ToolLifecycle
  permission?: ObservedPermissionRequest
  question?: ObservedQuestionRequest
  lastAssistantMessage?: string
  /** The latest meaningful user prompt, when it can be read from history/transcript. */
  promptContext?: string
  /** Timestamp from the most recent transcript event we observed. */
  lastActivityAt?: number
  /** Timestamp of the most recent completed tool call. */
  lastToolFinishedAt?: number
}


// ============================================================================
// Error Types
// ============================================================================

export class ClaudeObservationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly sessionId?: string
  ) {
    super(message)
    this.name = 'ClaudeObservationError'
  }
}

// ============================================================================
// Field Classification for Adapter
// ============================================================================

export type FieldSource = 'observed' | 'derived' | 'inferred' | 'mocked' | 'unavailable'

export interface WorkerFieldMetadata {
  field: keyof Worker
  source: FieldSource
  description: string
}
