import type { InteractionEvidence, InteractionKind } from '../types'

export const HOOK_SCHEMA_VERSION = 1

export const DEFAULT_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PostModelSwitch',
  'CwdChanged', 'DirectoryAdded', 'ConfigChange', 'TaskCreated', 'TaskCompleted',
  'TeammateIdle'
] as const

export type SupportedHookEvent = typeof DEFAULT_HOOK_EVENTS[number]
export type ObservationSource = 'hook' | 'metadata' | 'recovery' | 'process-exit' | 'enrichment'

export interface CollectorRecord {
  schemaVersion: number
  eventId: string
  event: string
  collectorObservedAt: number
  payload: unknown
  truncated?: boolean
}

export interface NormalizedHookEvent {
  schemaVersion: 1
  eventId: string
  installationId: string
  configRootId: string
  sessionId: string
  incarnationId?: string
  agentId?: string
  promptId?: string
  toolUseId?: string
  elicitationId?: string
  kind: SupportedHookEvent | 'MetadataChanged' | 'RecoverySnapshot' | 'RecoveryMissing' | 'ProcessExit'
  source: ObservationSource
  collectorObservedAt: number
  receiverReceivedAt: number
  receiverSequence: number
  data: Record<string, unknown>
  evidence: {
    classification: 'observed' | 'derived' | 'heuristic'
    correlation?: 'exact' | 'unique-fingerprint' | 'session-only' | 'none'
    completeness: 'complete' | 'partial'
    freshness: 'live' | 'recovered' | 'stale'
  }
}

export interface PendingInteraction {
  key: string
  kind: InteractionKind
  evidence: InteractionEvidence
  agentId: string
  toolUseId?: string
  fingerprint?: string
  requestedAt: number
  data: Record<string, unknown>
}

export interface ObservedToolCall {
  key: string
  id: string
  agentId: string
  name: string
  inputFingerprint: string
  input: Record<string, unknown>
  requestedAt: number
  terminal?: 'success' | 'failure' | 'denied' | 'batch'
  terminalAt?: number
}
