import { basename, dirname, isAbsolute, join } from 'node:path'
import type { ClaudeSessionState, ObservedQuestionRequest, ObservedToolSummary } from '../types'
import { fingerprint } from './HookNormalizer'
import type { NormalizedHookEvent, ObservedToolCall, PendingInteraction } from './HookTypes'

type SessionRecord = {
  state: ClaudeSessionState
  tools: Record<string, ObservedToolCall>
  interactions: Record<string, PendingInteraction>
  terminalToolIds: string[]
  childIds: string[]
}

export type ReducerCheckpoint = { sessions: SessionRecord[] }

const clone = <T>(value: T): T => structuredClone(value)
const value = (data: Record<string, unknown>, key: string): string | undefined => typeof data[key] === 'string' ? data[key] as string : undefined

export class HookEventReducer {
  private readonly sessions = new Map<string, SessionRecord>()

  restore(checkpoint?: ReducerCheckpoint): void {
    this.sessions.clear()
    for (const record of checkpoint?.sessions || []) this.sessions.set(record.state.sessionId, clone(record))
  }

  checkpoint(): ReducerCheckpoint { return { sessions: [...this.sessions.values()].map(clone) } }
  snapshots(): ClaudeSessionState[] { return [...this.sessions.values()].map(record => clone(record.state)) }
  snapshot(sessionId: string): ClaudeSessionState | undefined { const record = this.sessions.get(sessionId); return record ? clone(record.state) : undefined }

  apply(event: NormalizedHookEvent): ClaudeSessionState {
    const record = this.sessions.get(event.sessionId) || this.create(event)
    this.sessions.set(event.sessionId, record)
    const state = record.state
    state.lastEventAt = event.receiverReceivedAt
    state.configRootId = event.configRootId
    if (event.incarnationId) state.incarnationId = event.incarnationId
    if (event.source === 'hook') state.coverage = state.coverage === 'recovery-only' ? 'partial' : 'hooks-seen'
    if (event.evidence.completeness === 'partial') state.coverage = 'partial'
    const agentId = event.agentId || 'main'

    switch (event.kind) {
      case 'SessionStart':
        state.lifecycle = 'live'
        state.status = 'idle'
        state.activityPhase = 'starting'
        state.startedAt = state.startedAt || event.collectorObservedAt
        state.cwd = value(event.data, 'cwd') || state.cwd
        state.name = value(event.data, 'sessionTitle') || state.name
        state.model = value(event.data, 'model') || state.model
        state.effort = value(event.data, 'effort') || state.effort
        this.activity(state, 'session started', event)
        break
      case 'UserPromptSubmit': {
        const prompt = value(event.data, 'prompt')
        state.status = 'busy'; state.activityPhase = 'processing'; state.failure = undefined
        state.responseFinishedAt = undefined
        if (prompt) { state.lastPrompt = prompt; state.promptContext = prompt }
        this.resolveForegroundInteractions(record, agentId)
        this.activity(state, prompt ? `prompt · ${prompt}` : 'prompt submitted', event)
        break
      }
      case 'PreToolUse':
        this.preTool(record, event, agentId)
        break
      case 'PostToolUse':
        this.finishTool(record, event, agentId, 'success')
        break
      case 'PostToolUseFailure':
        this.finishTool(record, event, agentId, 'failure')
        break
      case 'PermissionDenied':
        this.finishTool(record, event, agentId, 'denied')
        break
      case 'PostToolBatch':
        this.finishBatch(record, event, agentId)
        break
      case 'PermissionRequest':
        this.permissionRequested(record, event, agentId)
        break
      case 'Notification':
        this.notification(record, event, agentId)
        break
      case 'Elicitation':
        this.elicitation(record, event, agentId)
        break
      case 'ElicitationResult':
        this.resolveElicitation(record, event, agentId)
        break
      case 'Stop':
        state.status = 'idle'; state.activityPhase = 'response-finished'; state.responseFinishedAt = event.collectorObservedAt
        state.lastAssistantMessage = value(event.data, 'lastAssistantMessage') || state.lastAssistantMessage
        this.activity(state, 'response finished', event)
        break
      case 'StopFailure':
        state.status = 'idle'; state.activityPhase = 'failed'; state.failure = value(event.data, 'error') || 'Claude response failed'
        this.activity(state, 'response failed', event)
        break
      case 'SessionEnd':
        state.lifecycle = 'ended'; state.status = 'idle'; state.activityPhase = 'ended'
        this.resolveAllInteractions(record, 'unknown')
        this.activity(state, 'session ended', event)
        break
      case 'PreCompact':
        state.status = 'busy'; state.activityPhase = 'compacting'; this.activity(state, 'compacting context', event); break
      case 'PostCompact':
        state.status = 'busy'; state.activityPhase = 'processing'; this.activity(state, 'context compacted', event); break
      case 'PostModelSwitch':
        state.model = value(event.data, 'model') || state.model; this.activity(state, 'model switched', event); break
      case 'CwdChanged':
        state.cwd = value(event.data, 'cwd') || state.cwd; this.activity(state, 'working directory changed', event); break
      case 'SubagentStart':
        if (event.agentId && !record.childIds.includes(event.agentId)) record.childIds.push(event.agentId)
        state.activeChildCount = record.childIds.length; state.status = 'busy'; state.activityPhase = 'processing'
        this.activity(state, `subagent started · ${value(event.data, 'agentType') || event.agentId || 'agent'}`, event); break
      case 'SubagentStop':
        if (event.agentId) record.childIds = record.childIds.filter(id => id !== event.agentId)
        if (event.agentId) for (const interaction of Object.values(record.interactions)) if (interaction.agentId === event.agentId) interaction.evidence = 'resolved'
        state.activeChildCount = record.childIds.length; this.activity(state, 'subagent finished', event); break
      case 'RecoverySnapshot':
      case 'MetadataChanged':
        this.applyRecoveredState(record, event)
        break
      case 'RecoveryMissing':
        state.coverage = 'stale'
        state.interactionEvidence = 'unknown'
        this.activity(state, 'session presence could not be verified', event)
        break
      case 'ProcessExit':
        state.lifecycle = 'ended'; state.status = 'idle'; state.activityPhase = 'ended'; this.activity(state, 'process exited · outcome unknown', event); break
      default:
        this.activity(state, humanize(event.kind), event)
    }
    this.projectInteractions(record)
    return clone(state)
  }

  private create(event: NormalizedHookEvent): SessionRecord {
    const cwd = value(event.data, 'cwd') || ''
    return {
      state: {
        pid: 0, sessionId: event.sessionId, name: value(event.data, 'sessionTitle') || basename(cwd) || 'Claude',
        status: 'idle', cwd, startedAt: event.collectorObservedAt, kind: 'interactive', activityPhase: 'unknown',
        coverage: event.source === 'hook' ? 'hooks-seen' : 'recovery-only', lifecycle: 'unknown', activity: []
      },
      tools: {}, interactions: {}, terminalToolIds: [], childIds: []
    }
  }

  private preTool(record: SessionRecord, event: NormalizedHookEvent, agentId: string): void {
    const id = event.toolUseId
    const key = `${agentId}:${id}`
    if (!id || record.terminalToolIds.includes(key)) return
    const name = value(event.data, 'toolName') || 'Tool'
    const input = (event.data.toolInput || {}) as Record<string, unknown>
    if (!record.tools[key]) {
      record.tools[key] = { key, id, agentId, name, inputFingerprint: fingerprint(input), input, requestedAt: event.collectorObservedAt }
      this.countTool(record.state, name, event.collectorObservedAt)
    }
    const state = record.state
    state.status = 'busy'; state.activityPhase = toolPhase(name)
    if (agentId === 'main') { state.currentTool = name; state.toolLifecycle = 'active' }
    const file = toolFile(input)
    if (file && agentId === 'main') { state.currentFile = isAbsolute(file) ? file : join(state.cwd, file); state.fileOperation = toolOperation(name); this.recordFile(state, state.currentFile) }
    if (name === 'AskUserQuestion') {
      const question = parseQuestions(input)
      record.interactions[`question:${key}`] = { key: `question:${key}`, kind: 'question', evidence: 'requested', agentId, toolUseId: id, requestedAt: event.collectorObservedAt, data: question ? { question } : {} }
    }
    this.activity(state, `requested · ${name.toLowerCase()}${file ? ` · ${basename(file)}` : ''}`, event)
  }

  private finishTool(record: SessionRecord, event: NormalizedHookEvent, agentId: string, terminal: NonNullable<ObservedToolCall['terminal']>): void {
    const id = event.toolUseId
    if (!id) return
    const key = `${agentId}:${id}`
    const tool = record.tools[key]
    if (record.terminalToolIds.includes(key)) return
    record.terminalToolIds = [...record.terminalToolIds, key].slice(-512)
    if (tool) { tool.terminal = terminal; tool.terminalAt = event.collectorObservedAt; record.state.currentTool = tool.name }
    for (const interaction of Object.values(record.interactions)) if (interaction.agentId === agentId && interaction.toolUseId === id) interaction.evidence = 'resolved'
    record.state.status = 'busy'; record.state.activityPhase = terminal === 'failure' ? 'failed' : 'tool-finished'; record.state.toolLifecycle = 'finished'; record.state.lastToolFinishedAt = event.collectorObservedAt
    this.activity(record.state, `${terminal === 'success' ? 'finished' : terminal} · ${(tool?.name || value(event.data, 'toolName') || 'tool').toLowerCase()}`, event)
  }

  private finishBatch(record: SessionRecord, event: NormalizedHookEvent, agentId: string): void {
    for (const item of Array.isArray(event.data.results) ? event.data.results : []) {
      const result = item as Record<string, unknown>; const id = value(result, 'toolUseId'); if (!id) continue
      this.finishTool(record, { ...event, toolUseId: id }, agentId, 'batch')
    }
  }

  private permissionRequested(record: SessionRecord, event: NormalizedHookEvent, agentId: string): void {
    const toolName = value(event.data, 'toolName') || 'tool action'
    const input = (event.data.toolInput || {}) as Record<string, unknown>
    const fp = `${toolName}:${fingerprint(input)}`
    const candidates = Object.values(record.tools).filter(tool => tool.agentId === agentId && !tool.terminal && `${tool.name}:${tool.inputFingerprint}` === fp)
    const toolUseId = candidates.length === 1 ? candidates[0].id : undefined
    const key = `permission:${agentId}:${toolUseId || event.eventId}`
    record.interactions[key] = { key, kind: 'permission', evidence: 'requested', agentId, toolUseId, fingerprint: fp, requestedAt: event.collectorObservedAt, data: { toolName } }
    record.state.activityPhase = 'response-end-pending'
    this.activity(record.state, `permission decision requested · ${toolName.toLowerCase()}`, event)
  }

  private notification(record: SessionRecord, event: NormalizedHookEvent, agentId: string): void {
    const kind = value(event.data, 'notificationType')
    if (kind === 'permission_prompt') {
      const pending = Object.values(record.interactions).filter(item => item.agentId === agentId && item.kind === 'permission' && item.evidence === 'requested')
      if (pending.length === 1) pending[0].evidence = 'confirmed-waiting'
      else {
        const key = `permission:${agentId}:notification:${event.eventId}`
        record.interactions[key] = { key, kind: 'permission', evidence: 'confirmed-waiting', agentId, requestedAt: event.collectorObservedAt, data: { toolName: 'tool action' } }
      }
    } else if (kind === 'elicitation_dialog') {
      const pending = Object.values(record.interactions).filter(item => item.agentId === agentId && item.kind === 'elicitation' && item.evidence === 'requested')
      if (pending.length === 1) pending[0].evidence = 'confirmed-waiting'
    }
    this.activity(record.state, `notification · ${kind || 'unknown'}`, event)
  }

  private elicitation(record: SessionRecord, event: NormalizedHookEvent, agentId: string): void {
    const key = `elicitation:${agentId}:${event.elicitationId || event.eventId}`
    record.interactions[key] = { key, kind: 'elicitation', evidence: 'requested', agentId, requestedAt: event.collectorObservedAt, data: event.data }
    this.activity(record.state, 'elicitation requested', event)
  }

  private resolveElicitation(record: SessionRecord, event: NormalizedHookEvent, agentId: string): void {
    const exact = event.elicitationId && record.interactions[`elicitation:${agentId}:${event.elicitationId}`]
    if (exact) exact.evidence = 'resolved'
    else {
      const candidates = Object.values(record.interactions).filter(item => item.agentId === agentId && item.kind === 'elicitation' && item.evidence !== 'resolved')
      if (candidates.length === 1) candidates[0].evidence = 'resolved'
    }
    this.activity(record.state, 'elicitation resolved', event)
  }

  private applyRecoveredState(record: SessionRecord, event: NormalizedHookEvent): void {
    const state = record.state
    const status = value(event.data, 'status')
    if (status === 'busy' || status === 'idle' || status === 'waiting') state.status = status
    const pid = event.data.pid; if (typeof pid === 'number' && pid > 0) state.pid = pid
    state.cwd = value(event.data, 'cwd') || state.cwd; state.name = value(event.data, 'name') || state.name
    const startedAt = event.data.startedAt; if (typeof startedAt === 'number' && startedAt > 0) state.startedAt = startedAt
    state.lifecycle = 'live'
    if (state.coverage !== 'hooks-seen') state.coverage = event.kind === 'RecoverySnapshot' ? 'recovery-only' : 'partial'
    if (status === 'waiting') {
      const pending = Object.values(record.interactions).filter(item => item.evidence === 'requested')
      if (pending.length === 1) pending[0].evidence = 'confirmed-waiting'
      else { state.interactionKind = 'unknown'; state.interactionEvidence = 'confirmed-waiting'; state.waitingFor = 'unknown' }
    } else if (status === 'busy') {
      for (const interaction of Object.values(record.interactions)) if (interaction.evidence === 'confirmed-waiting') interaction.evidence = 'resolved'
      state.activityPhase = 'processing'
    } else if (status === 'idle' && state.activityPhase !== 'response-finished') state.activityPhase = 'idle'
  }

  private projectInteractions(record: SessionRecord): void {
    const unresolved = Object.values(record.interactions).filter(item => item.evidence !== 'resolved')
    const confirmed = unresolved.filter(item => item.evidence === 'confirmed-waiting')
    const focus = confirmed.at(-1) || unresolved.at(-1)
    const state = record.state
    state.waitingChildCount = confirmed.filter(item => item.agentId !== 'main').length
    if (!focus) {
      if (state.interactionEvidence !== 'confirmed-waiting' || state.waitingFor !== 'unknown') {
        state.interactionKind = undefined; state.interactionEvidence = undefined; state.waitingFor = undefined
      }
      state.permission = undefined; state.question = undefined
      return
    }
    state.interactionKind = focus.kind; state.interactionEvidence = focus.evidence
    state.waitingFor = focus.kind
    if (focus.evidence === 'confirmed-waiting') { state.status = 'waiting'; state.activityPhase = focus.kind === 'permission' ? 'permission' : 'waiting' }
    state.permission = focus.kind === 'permission' ? {
      command: value(focus.data, 'toolName') || 'tool action',
      question: focus.evidence === 'confirmed-waiting' ? 'Claude Code is waiting for permission to continue with {command}.' : 'Claude Code requested a permission decision for {command}.',
      evidence: focus.evidence
    } : undefined
    state.question = focus.kind === 'question' ? focus.data.question as ObservedQuestionRequest | undefined : undefined
  }

  private resolveForegroundInteractions(record: SessionRecord, agentId: string): void {
    for (const interaction of Object.values(record.interactions)) if (interaction.agentId === agentId) interaction.evidence = 'resolved'
  }
  private resolveAllInteractions(record: SessionRecord, evidence: 'resolved' | 'unknown'): void { for (const item of Object.values(record.interactions)) item.evidence = evidence }
  private countTool(state: ClaudeSessionState, name: string, at: number): void {
    const tools = new Map((state.tools || []).map(tool => [tool.name, tool]))
    const previous = tools.get(name); tools.set(name, { name, count: (previous?.count || 0) + 1, lastUsedAt: at })
    state.tools = [...tools.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 12) as ObservedToolSummary[]
  }
  private recordFile(state: ClaudeSessionState, file: string): void { state.relevantFiles = [file, ...(state.relevantFiles || []).filter(item => item !== file)].slice(0, 12) }
  private activity(state: ClaudeSessionState, text: string, event: NormalizedHookEvent): void {
    const time = new Date(event.collectorObservedAt)
    const item = { time: `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`, text, current: true, observedAt: event.collectorObservedAt }
    state.activity = [...(state.activity || []).map(activity => ({ ...activity, current: false })), item].slice(-20)
    state.lastActivityAt = event.collectorObservedAt
  }
}

function toolFile(input: Record<string, unknown>): string | undefined { for (const key of ['file_path', 'path', 'notebook_path']) if (typeof input[key] === 'string') return input[key] as string; return undefined }
function toolOperation(name: string): 'EDITING' | 'READING' | undefined { return /^(Edit|Write|NotebookEdit)$/i.test(name) ? 'EDITING' : /^Read$/i.test(name) ? 'READING' : undefined }
function toolPhase(name: string): ClaudeSessionState['activityPhase'] { return toolOperation(name) === 'EDITING' ? 'editing' : toolOperation(name) === 'READING' ? 'reading' : 'tool' }
function parseQuestions(input: Record<string, unknown>): ObservedQuestionRequest | undefined { const questions = input.questions; return Array.isArray(questions) && questions.length ? { questions: questions as ObservedQuestionRequest['questions'] } : undefined }
function humanize(value: string): string { return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() }
