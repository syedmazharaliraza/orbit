import { createHash } from 'node:crypto'
import { DEFAULT_HOOK_EVENTS, HOOK_SCHEMA_VERSION, type CollectorRecord, type NormalizedHookEvent, type SupportedHookEvent } from './HookTypes'

const MAX_ID = 512
const MAX_PROMPT = 360
const MAX_MESSAGE = 2_048
const supported = new Set<string>(DEFAULT_HOOK_EVENTS)

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, limit: number): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value) || 'null'
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

export function normalizeCollectorRecord(
  record: CollectorRecord,
  sequence: number,
  installationId: string,
  configRootId: string,
  now = Date.now()
): NormalizedHookEvent | undefined {
  if (record.schemaVersion !== HOOK_SCHEMA_VERSION || !supported.has(record.event)) return undefined
  const payload = object(record.payload)
  const sessionId = text(payload.session_id, MAX_ID)
  if (!sessionId || !text(record.eventId, MAX_ID)) return undefined

  const kind = record.event as SupportedHookEvent
  const data = minimize(kind, payload)
  return {
    schemaVersion: HOOK_SCHEMA_VERSION,
    eventId: record.eventId,
    installationId,
    configRootId,
    sessionId,
    incarnationId: text(payload.incarnation_id, MAX_ID),
    agentId: text(payload.agent_id, MAX_ID),
    promptId: text(payload.prompt_id, MAX_ID),
    toolUseId: text(payload.tool_use_id, MAX_ID),
    elicitationId: text(payload.elicitation_id, MAX_ID),
    kind,
    source: 'hook',
    collectorObservedAt: Number.isFinite(record.collectorObservedAt) ? record.collectorObservedAt : now,
    receiverReceivedAt: now,
    receiverSequence: sequence,
    data,
    evidence: {
      classification: 'observed',
      correlation: record.event === 'Notification' ? 'session-only' : 'exact',
      completeness: record.truncated ? 'partial' : 'complete',
      freshness: 'live'
    }
  }
}

function minimize(kind: SupportedHookEvent, payload: Record<string, unknown>): Record<string, unknown> {
  const contextual = object(payload.context)
  const data: Record<string, unknown> = {
    cwd: text(payload.cwd, 4_096),
    model: text(payload.model, 256),
    sessionTitle: text(payload.session_title, 512),
    source: text(payload.source, 64),
    effort: text(object(contextual.effort).level, 64)
  }

  switch (kind) {
    case 'UserPromptSubmit':
      data.prompt = text(payload.prompt, MAX_PROMPT)
      break
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    case 'PermissionDenied':
      data.toolName = text(payload.tool_name, 256)
      data.toolInput = minimizeToolInput(object(payload.tool_input))
      data.error = text(payload.error, 1_024)
      data.interrupted = payload.is_interrupt === true || payload.interrupted === true
      break
    case 'PostToolBatch':
      data.results = Array.isArray(payload.results) ? payload.results.slice(0, 64).map(item => {
        const result = object(item)
        return { toolUseId: text(result.tool_use_id, MAX_ID), status: text(result.status, 32) }
      }) : []
      break
    case 'Notification':
      data.notificationType = text(payload.notification_type, 128)
      break
    case 'Elicitation':
      data.serverName = text(payload.server_name, 256)
      data.mode = text(payload.mode, 64)
      data.requestedFields = Object.keys(object(payload.request)).slice(0, 64)
      break
    case 'ElicitationResult':
      data.action = text(payload.action, 64)
      break
    case 'Stop':
    case 'SubagentStop':
      data.lastAssistantMessage = text(payload.last_assistant_message, MAX_MESSAGE)
      data.stopHookActive = payload.stop_hook_active === true
      break
    case 'StopFailure':
      data.error = text(payload.error, 1_024)
      break
    case 'SessionEnd':
      data.reason = text(payload.reason, 256)
      break
    case 'SubagentStart':
      data.agentType = text(payload.agent_type, 128)
      break
    case 'PostModelSwitch':
      data.model = text(payload.to_model, 256)
      break
    case 'CwdChanged':
      data.cwd = text(payload.cwd, 4_096) || text(payload.new_cwd, 4_096)
      break
    case 'DirectoryAdded':
      data.directory = text(payload.directory, 4_096)
      break
    case 'TaskCreated':
    case 'TaskCompleted':
      data.taskId = text(payload.task_id, MAX_ID)
      data.subject = text(payload.subject, 512)
      break
  }
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
}

function minimizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern', 'query']) {
    const value = text(input[key], key.includes('path') ? 4_096 : 512)
    if (value) result[key] = value
  }
  if (typeof input.command === 'string') result.commandFingerprint = fingerprint(input.command)
  else if (typeof input.command_fingerprint === 'string') result.commandFingerprint = input.command_fingerprint.slice(0, 128)
  if (Array.isArray(input.questions)) {
    result.questions = input.questions.slice(0, 8).flatMap(raw => {
      const question = object(raw)
      const prompt = text(question.question, 1_024)
      if (!prompt) return []
      return [{
        question: prompt,
        header: text(question.header, 128),
        multiSelect: question.multiSelect === true,
        options: Array.isArray(question.options) ? question.options.slice(0, 16).flatMap(rawOption => {
          const option = object(rawOption)
          const label = text(option.label, 256)
          return label ? [{ label, description: text(option.description, 512) }] : []
        }) : []
      }]
    })
  }
  return result
}
