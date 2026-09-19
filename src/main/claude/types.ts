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
// History Types (from ~/.claude/history.jsonl)
// ============================================================================

export interface HistoryEntry {
  display: string
  timestamp: number
  project: string
  sessionId: string
}

// ============================================================================
// Transcript Types (from ~/.claude/projects/<encoded>/<sessionId>.jsonl)
// ============================================================================

export interface TranscriptCheckpoint {
  sessionId: string
  byteOffset: number
  lastEventUuid: string | null
  lastUpdated: number
}

export interface TranscriptEvent {
  type: string
  uuid: string
  parentUuid?: string
  timestamp: string
  sessionId: string
  cwd?: string
  gitBranch?: string
  [key: string]: unknown
}

export interface LastPromptEvent extends TranscriptEvent {
  type: 'last-prompt'
  lastPrompt?: string
  leafUuid?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: {
    file_path?: string
    path?: string
    notebook_path?: string
    command?: string
    pattern?: string
    query?: string
    [key: string]: unknown
  }
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

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | { type: string; text?: string }[]
  is_error?: boolean
}

export interface AssistantMessageEvent extends TranscriptEvent {
  type: 'assistant'
  message: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens_details?: { thinking_tokens?: number }
    }
    content: unknown[]
    stop_reason?: string | null
  }
}

export interface UserMessageEvent extends TranscriptEvent {
  type: 'user'
  message: {
    content: unknown[] | string
  }
  toolUseResult?: unknown
}

export interface TokenReminderAttachment extends TranscriptEvent {
  type: 'attachment'
  attachment: {
    type: 'total_tokens_reminder'
    text: string
  }
}

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
// Configuration
// ============================================================================

export interface ObservationConfig {
  discoveryInterval: number // Default 3000ms
  transcriptEnabled: boolean // Default true
  maxActivityHistory: number // Default 20
  fallbackMode: 'graceful' | 'strict' // Default graceful
  useFilesystemWatching: boolean // Default true
  pollingFallbackInterval: number // Default 1000ms (when fs.watch fails)
}

export const DEFAULT_OBSERVATION_CONFIG: ObservationConfig = {
  discoveryInterval: 3000,
  transcriptEnabled: true,
  maxActivityHistory: 20,
  fallbackMode: 'graceful',
  useFilesystemWatching: true,
  pollingFallbackInterval: 1000
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
