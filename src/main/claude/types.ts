/**
 * Type definitions for Claude Code session observation
 * Stage 6: Read-only observation of local Claude Code sessions
 */

export type Activity = { time: string; text: string; current?: boolean; observedAt?: number }
export type ClaudeSessionStatus = 'busy' | 'idle' | 'waiting'
export type ObservationCoverage = 'hooks-seen' | 'recovery-only' | 'partial' | 'disabled' | 'stale'
export type InteractionEvidence = 'requested' | 'confirmed-waiting' | 'resolved' | 'unknown'
export type InteractionKind = 'question' | 'permission' | 'elicitation' | 'other-input' | 'unknown'
export type SessionLifecycle = 'unknown' | 'live' | 'ended'

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
// Aggregated Session State
// ============================================================================

/**
 * A stable, user-facing interpretation of normalized observations. This is deliberately
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
  | 'compacting'
  | 'response-end-pending'
  | 'response-finished'
  | 'failed'
  | 'ended'
  | 'unknown'

export type ToolLifecycle = 'active' | 'finished'

export interface ObservedPermissionRequest {
  command: string
  question: string
  detail?: string
  evidence?: InteractionEvidence
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

  sessionTitle?: string
  currentToolActivity?: string
  currentCommand?: string
  currentToolDescription?: string
  currentSearch?: string
  inputPreview?: string

  // From history.jsonl (optional)
  initialTask?: string

  // From transcript tailing (optional)
  lastPrompt?: string
  currentTool?: string
  currentToolUseId?: string
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
  /** Hook/recovery coverage is independent from the user-facing activity state. */
  coverage?: ObservationCoverage
  lifecycle?: SessionLifecycle
  interactionEvidence?: InteractionEvidence
  interactionKind?: InteractionKind
  responseFinishedAt?: number
  lastEventAt?: number
  failure?: string
  incarnationId?: string
  configRootId?: string
  activeChildCount?: number
  waitingChildCount?: number
}
