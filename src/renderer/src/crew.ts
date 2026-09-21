export type Mark = 'bar' | 'dot' | 'two' | 'ring' | 'diamond' | 'square'
export type WorkerState = 'working' | 'waiting' | 'stuck' | 'drift' | 'done' | 'idle'
export type PresentationState = 'working' | 'waiting' | 'attention' | 'done' | 'idle'
export type Priority = 'P1' | 'P2' | 'P3'
export type Signal = { kind: 'stuck' | 'drift' | 'inactive'; confidence: number; evidence: string; rule?: string; heuristic?: true }

/** Only the information needed to recognize, observe and navigate to a worker. */
export type Worker = {
  id: string; name: string; title: string; action: string
  context?: { label: string; text: string; code?: boolean; choices?: never; remaining?: never }
    | { label: 'Choices'; choices: string[]; remaining: number; text?: never; code?: never }
  hue: number; mark: Mark; delay: string
  state: WorkerState; presentation: PresentationState; priority: Priority
  permission?: boolean; question?: boolean; waitingFor?: string; signal?: Signal
}

export const crew: Worker[] = [
  { id: 'wren', name: 'Wren', title: 'Fix booking timezone', action: 'Run the migration against the local booking database?', context: { label: 'Command', text: 'pnpm db:migrate', code: true }, hue: 25, mark: 'bar', delay: '-.7s', state: 'waiting', presentation: 'waiting', priority: 'P1', permission: true },
  { id: 'moss', name: 'Moss', title: 'Migrate settings form', action: 'Editing SettingsForm.tsx', context: { label: 'File', text: 'src/settings/SettingsForm.tsx', code: true }, hue: 150, mark: 'dot', delay: '-2.2s', state: 'working', presentation: 'working', priority: 'P2' },
  { id: 'dune', name: 'Dune', title: 'Consolidate dark-mode tokens', action: 'The token pass is complete', hue: 200, mark: 'square', delay: '-1.4s', state: 'done', presentation: 'done', priority: 'P3' },
  { id: 'pike', name: 'Pike', title: 'Debug checkout CI failure', action: 'Running tests', context: { label: 'Command', text: 'pnpm test:e2e checkout', code: true }, hue: 250, mark: 'two', delay: '-3.2s', state: 'stuck', presentation: 'attention', priority: 'P1', signal: { kind: 'stuck', confidence: 61, evidence: 'The same test has repeated six times.' } },
  { id: 'tern', name: 'Tern', title: 'Unify API retries', action: 'Editing refresh.ts', hue: 300, mark: 'diamond', delay: '-.2s', state: 'drift', presentation: 'attention', priority: 'P2', signal: { kind: 'drift', confidence: 61, evidence: 'Recent files may be unrelated to this task.' } },
  { id: 'volt', name: 'Volt', title: 'Fix production build', action: 'Building the production bundle', context: { label: 'Command', text: 'pnpm build', code: true }, hue: 60, mark: 'ring', delay: '-2.8s', state: 'working', presentation: 'working', priority: 'P3' }
]

export const orbitSlots = [
  { left: 165, top: 82, size: 50, inner: true },
  { left: 272, top: 118, size: 36 }, { left: 266, top: 234, size: 34 }, { left: 158, top: 246, size: 40 }, { left: 62, top: 232, size: 34 }, { left: 58, top: 116, size: 34 }
]

export function orderedCrew(workers = crew): Worker[] {
  // Attention is surfaced first, while the original array index remains the
  // final tie-breaker. This keeps ordinary transcript updates from reordering
  // the orbit and lets CSS move a worker smoothly when its attention changes.
  const stateRank: Record<WorkerState, number> = { waiting: 0, stuck: 1, drift: 2, done: 3, working: 4, idle: 5 }
  const priorityRank: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 }
  return workers
    .map((worker, index) => ({ worker, index }))
    .sort((a, b) => stateRank[a.worker.state] - stateRank[b.worker.state] || priorityRank[a.worker.priority] - priorityRank[b.worker.priority] || a.index - b.index)
    .map(({ worker }) => worker)
}

export type CollapsedKind = 'empty' | 'attention' | 'working' | 'done' | 'idle'
export type CollapsedSummary = { kind: CollapsedKind; count: number; label: string; extra?: string; leader?: Worker; attention: Worker[] }

/**
 * The collapsed pod reports the strongest observed condition, never an
 * interpretation of a transcript. Attention entries are deliberately ranked
 * ahead of active work and retain a stable worker-id tie-breaker so a burst of
 * transcript events cannot reshuffle the pod.
 */
export function collapsedSummary(workers: Worker[]): CollapsedSummary {
  if (!workers.length) return { kind: 'empty', count: 0, label: 'observing', attention: [] }

  const attention = workers.filter(isCollapsedAttention).sort(compareAttention)
  if (attention.length) {
    const leader = attention[0]
    return {
      kind: 'attention',
      count: attention.length,
      leader,
      attention,
      label: collapsedAttentionLabel(leader),
      extra: attention.length > 1 ? `+${attention.length - 1}` : undefined
    }
  }

  const active = workers.filter(worker => worker.state === 'working')
  if (active.length) return { kind: 'working', count: active.length, label: active.length === 1 ? 'active' : 'active', extra: workers.length > active.length ? `${workers.length} seen` : undefined, attention: [] }

  const completed = workers.filter(worker => worker.state === 'done')
  if (completed.length) return { kind: 'done', count: completed.length, label: completed.length === 1 ? 'finished' : 'finished', extra: workers.length > completed.length ? `${workers.length} seen` : undefined, attention: [] }

  return { kind: 'idle', count: workers.length, label: workers.length === 1 ? 'idle' : 'idle', attention: [] }
}

function isCollapsedAttention(worker: Worker): boolean {
  return Boolean(worker.permission || worker.question || worker.state === 'waiting' || worker.signal || worker.state === 'stuck' || worker.state === 'drift')
}

function attentionRank(worker: Worker): number {
  if (worker.permission || /permission|approval|approve|allow/i.test(worker.waitingFor || '')) return 0
  if (worker.question) return 1
  if (worker.state === 'waiting') return 2
  if (worker.state === 'stuck' || worker.signal?.kind === 'stuck' || worker.signal?.kind === 'inactive') return 3
  return 4
}

function compareAttention(a: Worker, b: Worker): number {
  const priorityRank: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 }
  return attentionRank(a) - attentionRank(b) || priorityRank[a.priority] - priorityRank[b.priority] || a.id.localeCompare(b.id)
}

function collapsedAttentionLabel(worker: Worker): string {
  if (worker.permission || /permission|approval|approve|allow/i.test(worker.waitingFor || '')) return 'permission'
  if (worker.question) return 'needs input'
  if (worker.state === 'waiting') return 'waiting'
  return 'needs check'
}
