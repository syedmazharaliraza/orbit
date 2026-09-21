import assert from 'node:assert/strict'
import { classifySessionAttention } from '../src/main/claude/AttentionClassifier'
import { HookEventReducer } from '../src/main/claude/hooks/HookEventReducer'
import { normalizeCollectorRecord } from '../src/main/claude/hooks/HookNormalizer'
import type { CollectorRecord, SupportedHookEvent } from '../src/main/claude/hooks/HookTypes'

let sequence = 0
let clock = 1_700_000_000_000
const reducer = new HookEventReducer()

function apply(event: SupportedHookEvent, payload: Record<string, unknown>) {
  const record: CollectorRecord = { schemaVersion: 1, eventId: `event-${++sequence}`, event, collectorObservedAt: ++clock, payload }
  const normalized = normalizeCollectorRecord(record, sequence, 'test-installation', 'test-root', clock)!
  return reducer.apply(normalized)
}

const common = { session_id: 'session-1', cwd: '/tmp/project' }

apply('SessionStart', { ...common, session_title: 'Hook test', model: 'claude-sonnet-4-5' })
apply('UserPromptSubmit', { ...common, prompt: 'Please test the hook reducer.' })
const questionRequested = apply('PreToolUse', {
  ...common,
  tool_use_id: 'question-1',
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Choose one', options: [{ label: 'A', description: 'First' }] }] }
})
assert.equal(questionRequested.interactionEvidence, 'requested')
assert.equal(questionRequested.question?.questions[0].question, 'Choose one')
assert.notEqual(classifySessionAttention(questionRequested, clock).state, 'waiting', 'a request is not a confirmed human wait')

const confirmedQuestion = reducer.apply({
  schemaVersion: 1, eventId: `metadata-${++sequence}`, installationId: 'test-installation', configRootId: 'test-root', sessionId: 'session-1',
  kind: 'MetadataChanged', source: 'metadata', collectorObservedAt: ++clock, receiverReceivedAt: clock, receiverSequence: sequence,
  data: { status: 'waiting', cwd: '/tmp/project' }, evidence: { classification: 'observed', correlation: 'session-only', completeness: 'partial', freshness: 'live' }
})
assert.equal(confirmedQuestion.interactionEvidence, 'confirmed-waiting')
assert.equal(classifySessionAttention(confirmedQuestion, clock).state, 'waiting')

const resolvedQuestion = apply('PostToolUse', { ...common, tool_use_id: 'question-1', tool_name: 'AskUserQuestion', tool_input: {} })
assert.equal(resolvedQuestion.interactionEvidence, undefined)
assert.notEqual(classifySessionAttention(resolvedQuestion, clock).state, 'waiting')

apply('PreToolUse', { ...common, tool_use_id: 'bash-1', tool_name: 'Bash', tool_input: { command: 'printf ok' } })
const permissionRequested = apply('PermissionRequest', { ...common, tool_name: 'Bash', tool_input: { command: 'printf ok' } })
assert.equal(permissionRequested.interactionEvidence, 'requested')
assert.notEqual(classifySessionAttention(permissionRequested, clock).state, 'waiting')
const permissionConfirmed = apply('Notification', { ...common, notification_type: 'permission_prompt' })
assert.equal(permissionConfirmed.interactionEvidence, 'confirmed-waiting')
const permissionDenied = apply('PermissionDenied', { ...common, tool_use_id: 'bash-1', tool_name: 'Bash', tool_input: { command: 'printf ok' } })
assert.equal(permissionDenied.interactionEvidence, undefined, 'a denial closes rather than opens a permission wait')

const stopped = apply('Stop', { ...common, last_assistant_message: 'Finished the response.' })
assert.equal(stopped.activityPhase, 'response-finished')
assert.equal(stopped.lastAssistantMessage, 'Finished the response.')
assert.equal(classifySessionAttention(stopped, clock).state, 'done')
assert.equal(stopped.waitingFor, undefined, 'ordinary completion never becomes a user wait')

const ended = apply('SessionEnd', { ...common, reason: 'user_exit' })
assert.equal(ended.lifecycle, 'ended')
assert.equal(ended.activityPhase, 'ended')

const beforeDuplicate = stopped.tools?.find(tool => tool.name === 'Bash')?.count
apply('PreToolUse', { ...common, tool_use_id: 'bash-1', tool_name: 'Bash', tool_input: { command: 'printf ok' } })
const afterDuplicate = reducer.snapshot('session-1')?.tools?.find(tool => tool.name === 'Bash')?.count
assert.equal(afterDuplicate, beforeDuplicate, 'a late request cannot reopen a terminal tool call')

console.log('hook reducer tests passed')
