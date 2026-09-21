import { basename, relative } from 'node:path'
import type { Worker, Mark } from '../../renderer/src/crew'
import type { ClaudeSessionState } from './types'
import { classifySessionAttention } from './AttentionClassifier'

/** Projects observation into the small, glanceable surface sent to the renderer. */
export class ClaudeSessionToWorkerAdapter {
  toWorker(session: ClaudeSessionState): Worker {
    const attention = classifySessionAttention(session)
    let hash = 0
    for (const char of session.sessionId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
    const marks: Mark[] = ['bar', 'dot', 'two', 'ring', 'diamond', 'square']
    return {
      id: session.sessionId,
      name: session.name.split('-')[0] || 'Claude',
      title: workerTitle(session),
      action: workerActivity(session),
      context: workerContext(session),
      ...attention,
      hue: Math.abs(hash) % 360,
      mark: marks[(session.sessionId.charCodeAt(0) || 0) % marks.length],
      delay: `${-(Math.abs(hash) % 7 * .3 + .2).toFixed(1)}s`,
      permission: Boolean(session.permission),
      question: Boolean(session.question) || session.interactionKind === 'question',
      waitingFor: session.waitingFor
    }
  }
}

/** Normalize a small preview; CSS handles the final single-line ellipsis. */
export function previewLine(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/^[\s#>*-]+/, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

/** Pasted text is useful task context; its transport wrapper is not a title. */
function titleContent(text?: string): string {
  return (text || '')
    .replace(/&lt;(\/?pasted_content\b[^]*?)&gt;/gi, '<$1>')
    .replace(/<\/?pasted_content\b[^>]*>/gi, '\n')
    // The collector bounds prompts, so a long marker can arrive incomplete.
    .replace(/<\/?pasted_content\b[^>]*$/gi, '')
    .trim()
}

export function workerTitle(session: ClaudeSessionState): string {
  const sessionTitle = titleContent(session.sessionTitle)
  if (sessionTitle) return previewLine(sessionTitle)
  const prompt = titleContent(session.initialTask) || titleContent(session.lastPrompt)
  if (!prompt) return 'Claude Code session'
  const sentence = previewLine(prompt.split('\n').find(line => line.trim()) || prompt)
    .replace(/^(?:(?:please|can you|could you|would you|help me(?: to)?|I (?:want|need)(?: you)? to)\s+)+/i, '')
    .split(/(?<=[!?])\s|\.\s/)[0]
  const words = sentence.split(/\s+/)
  const short = words.slice(0, 7).join(' ').replace(/[.,:;]+$/, '')
  return short ? short.charAt(0).toUpperCase() + short.slice(1) + (words.length > 7 ? '…' : '') : 'Claude Code session'
}

export function workerActivity(session: ClaudeSessionState): string {
  const question = session.question?.questions[0]?.question
  if (question && (session.question || session.waitingFor || session.status === 'waiting')) return previewLine(question)
  if (session.interactionKind === 'question') return previewLine(session.inputPreview || '') || 'Waiting for input'
  if (session.permission) return previewLine(session.permission.detail || session.inputPreview || session.permission.question.replace('{command}', session.permission.command))
  if (session.inputPreview && (session.waitingFor || session.status === 'waiting')) return previewLine(session.inputPreview)
  if (session.status === 'waiting' || session.activityPhase === 'waiting') return 'Waiting for input'
  if (session.responseFinishedAt !== undefined) return previewLine(session.lastAssistantMessage || '') || 'Completed'
  if (session.activityPhase === 'failed') return 'Needs attention'
  if (session.activityPhase === 'idle' || session.status === 'idle') return 'Waiting for input'
  if (session.toolLifecycle !== 'active') return 'Thinking'
  const tool = session.currentTool || ''
  const file = session.currentFile ? basename(session.currentFile) : ''
  if (/^(Edit|Write|NotebookEdit)$/i.test(tool)) return file ? `Editing ${file}` : 'Editing file'
  if (/^Read$/i.test(tool)) return file ? `Reading ${file}` : 'Reading file'
  if (/^(Grep|Glob|Search)$/i.test(tool)) return 'Searching repository'
  if (/^(Bash|Shell)$/i.test(tool)) return previewLine(session.currentToolDescription || '') || session.currentToolActivity || 'Executing command'
  if (tool === 'AskUserQuestion') return 'Waiting for input'
  return tool ? 'Executing command' : 'Thinking'
}

/** One contextual detail, never a list of past activity or files. */
export function workerContext(session: ClaudeSessionState): Worker['context'] {
  const question = session.question?.questions[0]
  if (question) {
    const choices = question.options.slice(0, 4).map(option => previewLine(option.label))
    return choices.length ? { label: 'Choices', choices, remaining: Math.max(0, question.options.length - choices.length) } : undefined
  }
  if (session.permission) {
    const command = session.permission.command
    return command && command !== 'tool action' ? { label: 'Requested action', text: command, code: true } : undefined
  }
  if (session.status === 'waiting' || session.waitingFor || session.responseFinishedAt !== undefined || session.status === 'idle') return undefined
  const finished = session.toolLifecycle === 'finished'
  if (/^(Bash|Shell)$/i.test(session.currentTool || '') && session.currentCommand) {
    return { label: finished ? 'Just ran' : 'Command', text: session.currentCommand, code: true }
  }
  if (/^(Read|Edit|Write|NotebookEdit)$/i.test(session.currentTool || '') && session.currentFile) {
    const file = relative(session.cwd, session.currentFile) || basename(session.currentFile)
    const verb = session.fileOperation === 'EDITING' ? 'Just edited' : 'Just read'
    return { label: finished ? verb : 'File', text: file, code: true }
  }
  if (session.currentSearch) return { label: finished ? 'Just searched' : 'Searching for', text: session.currentSearch, code: true }
  return undefined
}
