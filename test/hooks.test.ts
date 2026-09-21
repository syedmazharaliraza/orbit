import assert from 'node:assert/strict'
import { ClaudeSessionToWorkerAdapter, workerActivity, workerTitle, workerContext } from '../src/main/claude/ClaudeSessionToWorkerAdapter'
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

// Completion does not expire, even if the response never used a tool.
const fresh = { session_id: 'session-preview', cwd: '/tmp/project' }
apply('UserPromptSubmit', { ...fresh, prompt: 'Please fix auth redirect' })
const noToolCompletion = apply('Stop', { ...fresh, last_assistant_message: '**Auth redirect fixed**\nTests passing.' })
assert.equal(classifySessionAttention(noToolCompletion, clock + 86_400_000).state, 'done')
assert.equal(workerActivity(noToolCompletion), 'Auth redirect fixed Tests passing.')
assert.equal(workerTitle(noToolCompletion), 'Fix auth redirect')
const resumed = apply('UserPromptSubmit', { ...fresh, prompt: 'Continue with Option B' })
assert.equal(resumed.lastAssistantMessage, undefined)
assert.equal(workerTitle(resumed), 'Fix auth redirect', 'follow-up input must not replace the original task title')
assert.equal(workerActivity(resumed), 'Thinking')
const reading = apply('PreToolUse', { ...fresh, tool_use_id: 'read-preview', tool_name: 'Read', tool_input: { file_path: '/tmp/project/WorkerStore.swift' } })
assert.equal(workerActivity(reading), 'Reading WorkerStore.swift')
const searching = apply('PreToolUse', { ...fresh, tool_use_id: 'search-preview', tool_name: 'Grep', tool_input: { pattern: 'auth' } })
assert.equal(searching.currentFile, undefined, 'the previous tool’s file must not leak into the new activity')
assert.equal(workerActivity(searching), 'Searching repository')
const testing = apply('PreToolUse', { ...fresh, session_title: 'Fix login navigation', tool_use_id: 'test-preview', tool_name: 'Bash', tool_input: { command: 'npm run test:unit' } })
assert.equal(workerActivity(testing), 'Running tests')
assert.equal(workerTitle(testing), 'Fix login navigation', 'Claude’s title takes precedence and is not split at hyphens')
assert.equal(workerActivity(apply('PostToolUse', { ...fresh, tool_use_id: 'test-preview', tool_name: 'Bash' })), 'Thinking')
assert.equal(workerActivity(questionRequested), 'Choose one')
assert.equal(workerActivity(permissionConfirmed), 'Run printf ok?')
const completionWithoutMessage = apply('Stop', fresh)
assert.equal(workerActivity(completionWithoutMessage), 'Completed', 'a missing final message must not reuse an old task’s output')
const adapter = new ClaudeSessionToWorkerAdapter()
const worker = adapter.toWorker(testing)
for (const field of ['branch', 'model', 'effort', 'usage', 'cost', 'activity', 'relevantFiles', 'message', 'budget', 'progress', 'filesGiven']) {
  assert.equal(field in worker, false, `${field} should not cross the preview boundary`)
}
assert.equal(workerTitle({ ...resumed, sessionTitle: undefined, initialTask: 'Could you please implement MCP picker' }), 'Implement MCP picker')
const detailed = { ...fresh, session_id: 'detailed-preview' }
apply('UserPromptSubmit', { ...detailed, prompt: 'Fix the migration' })
const commandInput = { command: 'pnpm db:migrate --database booking_local', description: 'Migrate the local booking database' }
const command = apply('PreToolUse', { ...detailed, tool_use_id: 'migration', tool_name: 'Bash', tool_input: commandInput })
assert.equal(workerActivity(command), 'Migrate the local booking database')
assert.deepEqual(workerContext(command), { label: 'Command', text: commandInput.command, code: true })
const permissionDetail = apply('PermissionRequest', { ...detailed, tool_name: 'Bash', tool_input: commandInput })
assert.equal(workerActivity(permissionDetail), commandInput.description)
assert.equal(workerContext(permissionDetail)?.text, commandInput.command)
const afterCommand = apply('PostToolUse', { ...detailed, tool_use_id: 'migration', tool_name: 'Bash', tool_input: commandInput })
assert.equal(workerActivity(afterCommand), 'Thinking')
assert.equal(workerContext(afterCommand)?.label, 'Just ran')
assert.equal(workerContext(reading)?.text, 'WorkerStore.swift')
assert.deepEqual(workerContext(questionRequested)?.choices, ['A'])
const nextTask = apply('UserPromptSubmit', { ...detailed, prompt: 'Now fix the next issue' })
assert.equal(workerContext(nextTask), undefined, 'new tasks clear stale command and file context')
assert.equal(workerContext(completionWithoutMessage), undefined, 'completed tasks show their final output without stale activity')
apply('PreToolUse', { ...detailed, tool_use_id: 'older-read', tool_name: 'Read', tool_input: { file_path: 'old_file.ts' } })
const newerRead = apply('PreToolUse', { ...detailed, tool_use_id: 'newer-read', tool_name: 'Read', tool_input: { file_path: 'new_file.ts' } })
const olderFinished = apply('PostToolUse', { ...detailed, tool_use_id: 'older-read', tool_name: 'Read' })
assert.equal(workerActivity(olderFinished), 'Reading new_file.ts', 'late tool completions cannot replace the latest activity')
assert.equal(workerContext(olderFinished)?.text, 'new_file.ts')
// AskUserQuestion also emits PermissionRequest/permission_prompt. Those are
// transport events for the same question, not another human approval.
const ask = { session_id: 'ask-permission-regression', cwd: '/tmp/project' }
const askInput = { questions: [{ question: 'What would you like to work on in this session?', options: [
  { label: 'Add new features', description: 'Build or extend functionality' },
  { label: 'Fix bugs or debug', description: 'Investigate unexpected behavior' },
  { label: 'Code review & cleanup' }, { label: 'Explore & explain' }
] }] }
apply('PreToolUse', { ...ask, tool_use_id: 'ask-1', tool_name: 'AskUserQuestion', tool_input: askInput })
const askPermission = apply('PermissionRequest', { ...ask, tool_name: 'AskUserQuestion', tool_input: askInput })
assert.equal(workerActivity(askPermission), askInput.questions[0].question)
assert.equal(askPermission.permission, undefined)
assert.equal(askPermission.interactionKind, 'question')
assert.deepEqual(workerContext(askPermission)?.choices, ['Add new features', 'Fix bugs or debug', 'Code review & cleanup', 'Explore & explain'])
for (let repeat = 0; repeat < 2; repeat++) {
  const waiting = apply('Notification', { ...ask, notification_type: 'permission_prompt', message: 'Claude needs permission to use AskUserQuestion' })
  assert.equal(waiting.interactionEvidence, 'confirmed-waiting')
  assert.equal(classifySessionAttention(waiting, clock).state, 'waiting')
  assert.equal(workerActivity(waiting), askInput.questions[0].question)
  assert.equal(waiting.permission, undefined, 'a notification must not mask the actual question')
}
const legacy = reducer.checkpoint()
const legacyRecord = legacy.sessions.find(item => item.state.sessionId === ask.session_id)!
legacyRecord.interactions['permission:legacy'] = { key: 'permission:legacy', agentId: 'main', toolUseId: 'ask-1', kind: 'permission', evidence: 'confirmed-waiting', requestedAt: clock, data: { toolName: 'AskUserQuestion' } }
const restored = new HookEventReducer()
restored.restore(legacy)
assert.equal(workerActivity(restored.snapshot(ask.session_id)!), askInput.questions[0].question, 'repair already-open questions from older checkpoints')
assert.equal(restored.snapshot(ask.session_id)!.permission, undefined)
const answered = apply('PostToolUse', { ...ask, tool_use_id: 'ask-1', tool_name: 'AskUserQuestion', tool_input: askInput })
assert.equal(answered.question, undefined)
assert.equal(answered.interactionKind, undefined)

const onlyPermission = apply('PermissionRequest', { session_id: 'missed-pre-question', tool_use_id: 'ask-only', tool_name: 'AskUserQuestion', tool_input: askInput })
assert.equal(workerActivity(onlyPermission), askInput.questions[0].question, 'PermissionRequest contains the question even when PreToolUse was missed')
assert.equal(onlyPermission.permission, undefined)
apply('PermissionRequest', { session_id: 'question-without-id', tool_name: 'AskUserQuestion', tool_input: askInput })
const answeredWithoutPre = apply('PostToolUse', { session_id: 'question-without-id', tool_use_id: 'discovered-id', tool_name: 'AskUserQuestion', tool_input: askInput })
assert.equal(answeredWithoutPre.question, undefined, 'questions observed without a pre-tool ID clear when answered')
const titleSession = { ...resumed, sessionTitle: undefined, lastPrompt: undefined }
assert.equal(workerTitle({ ...titleSession, initialTask: '\n\n<pasted_content id="513e">\nI want to simplify Orbit\nMore details follow' }), 'Simplify Orbit', 'derive a title from pasted text, not its wrapper')
assert.equal(workerTitle({ ...titleSession, initialTask: '<pasted_content id="a">Fix auth redirect</pasted_content>' }), 'Fix auth redirect')
assert.equal(workerTitle({ ...titleSession, initialTask: '<pasted_content id="a"></pasted_content>\nImplement MCP picker' }), 'Implement MCP picker')
assert.equal(workerTitle({ ...titleSession, initialTask: '<pasted_content id="truncated' }), 'Claude Code session')
assert.equal(workerTitle({ ...titleSession, initialTask: '&lt;pasted_content id="a"&gt;Refactor WorkerStore&lt;/pasted_content&gt;' }), 'Refactor WorkerStore')
assert.equal(workerTitle({ ...titleSession, initialTask: '<pasted_content id="a"/>', lastPrompt: 'Debug payments API' }), 'Debug payments API')
assert.equal(workerTitle({ ...titleSession, initialTask: 'Fix auth redirect', sessionTitle: '<pasted_content id="a"/>' }), 'Fix auth redirect')
assert.equal(workerTitle({ ...titleSession, initialTask: '<pasted_content id="a">Fix auth</pasted_content>', sessionTitle: 'Login navigation' }), 'Login navigation')
assert.equal(workerTitle({ ...titleSession, initialTask: '[Image #2]\n\nthere is one session where the permission is being asked' }), 'There is one session where the permission…', 'image references should be filtered from titles')
assert.equal(workerTitle({ ...titleSession, initialTask: '[Image #1] [Image #2] Fix the bug' }), 'Fix the bug', 'multiple image references should be filtered')

// Test URL removal
assert.equal(workerTitle({ ...titleSession, initialTask: 'Check https://example.com/api/endpoint for the bug' }), 'Check for the bug', 'URLs should be removed from titles')
assert.equal(workerTitle({ ...titleSession, initialTask: 'Deploy to https://staging.example.com' }), 'Deploy to', 'standalone URLs should be removed')

// Test file path normalization
assert.equal(workerTitle({ ...titleSession, initialTask: 'Fix /very/long/path/to/src/components/Auth.tsx' }), 'Fix Auth.tsx', 'long paths should be normalized to filename')
assert.equal(workerTitle({ ...titleSession, initialTask: 'Update /app/models/user.rb and test it' }), 'Update user.rb and test it', 'paths in middle of sentence should be normalized')

// Test markdown code block removal
assert.equal(workerTitle({ ...titleSession, initialTask: 'Fix this ```const x = 1``` issue' }), 'Fix this issue', 'inline code should be removed')
assert.equal(workerTitle({ ...titleSession, initialTask: '```typescript\nconst broken = true\n```\nFix the above' }), 'Fix the above', 'code blocks should be removed')

// Test markdown syntax removal
assert.equal(workerTitle({ ...titleSession, initialTask: '### Fix the authentication\n\nDetails below' }), 'Fix the authentication', 'markdown headers should be removed')
assert.equal(workerTitle({ ...titleSession, initialTask: '> Fix the bug\n> in production' }), 'Fix the bug', 'blockquotes should be removed')
assert.equal(workerTitle({ ...titleSession, initialTask: '- Fix auth\n- Update tests' }), 'Fix auth', 'list markers should be removed')

// Test timestamp removal
assert.equal(workerTitle({ ...titleSession, initialTask: '[2024-01-01 10:30:15] Fix the bug' }), 'Fix the bug', 'timestamps should be removed')
assert.equal(workerTitle({ ...titleSession, initialTask: 'Bug reported at (10:30 AM) - fix it' }), 'Bug reported at - fix it', 'time markers should be removed')

// Test command prefix removal
assert.equal(workerTitle({ ...titleSession, initialTask: '/search for auth bugs' }), 'For auth bugs', 'slash commands should be removed')
assert.equal(workerTitle({ ...titleSession, initialTask: '@claude fix the login flow' }), 'Fix the login flow', 'mentions should be removed')

// Test file attachment references
assert.equal(workerTitle({ ...titleSession, initialTask: '[Attachment: document.pdf] Review this' }), 'Review this', 'attachment references should be removed')
assert.equal(workerTitle({ ...titleSession, initialTask: '[screenshot.png] Fix the UI bug' }), 'Fix the UI bug', 'file references should be removed')

// Test excessive whitespace
assert.equal(workerTitle({ ...titleSession, initialTask: 'Fix    the     bug' }), 'Fix the bug', 'multiple spaces should be normalized')
assert.equal(workerTitle({ ...titleSession, initialTask: '\n\n\nFix the bug\n\n\n' }), 'Fix the bug', 'excessive newlines should be normalized')

// Test combined issues
assert.equal(workerTitle({ ...titleSession, initialTask: '[Image #1] https://example.com ```code``` Fix /path/to/file.tsx' }), 'Fix file.tsx', 'multiple issues should all be cleaned')
assert.equal(workerTitle({ ...titleSession, initialTask: '### [Attachment: file.pdf] @user /command Fix the bug' }), 'Fix the bug', 'complex combined patterns should be cleaned')

// Test edge cases
assert.equal(workerTitle({ ...titleSession, initialTask: '   \n\n   ' }), 'Claude Code session', 'whitespace-only prompts should use fallback')
assert.equal(workerTitle({ ...titleSession, initialTask: '[Image #1] [Image #2] [Image #3]' }), 'Claude Code session', 'only-noise prompts should use fallback')

console.log('hook reducer and worker preview tests passed')
