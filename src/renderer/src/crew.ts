export type Mark = 'bar' | 'dot' | 'two' | 'ring' | 'diamond' | 'square'
export type WorkerState = 'working' | 'waiting' | 'stuck' | 'drift' | 'done' | 'idle'
export type PresentationState = 'working' | 'waiting' | 'attention' | 'done' | 'idle'
export type Priority = 'P1' | 'P2' | 'P3'
export type FileTag = 'EDITING' | 'READING'

export type Activity = { time: string; text: string; current?: boolean; observedAt?: number }
export type ToolSummary = { name: string; count: number }
export type Usage = { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; thinkingTokens?: number; totalTokens: number; turnCount: number; lastInputTokens?: number; lastOutputTokens?: number }
export type Progress = { percent: number; label: string; touched: string[]; additionalTouched: number }
export type Permission = { command: string; question: string }
export type Question = { questions: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[] }
export type Signal = { kind: 'stuck' | 'drift' | 'inactive'; confidence: number; evidence: string; rule?: string; heuristic?: true; files?: { name: string; related?: boolean }[] }

export type Worker = {
  id: string; name: string; action: string; task: string; hue: number; mark: Mark; state: WorkerState; presentation: PresentationState; priority: Priority; elapsed: string; delay: string
  repo: string; branch: string; model: string; effort: string; file: string; path: string; edit: string; fileTag: FileTag
  tool: string; context: string; cost: string; activity: Activity[]; message: string; budget?: number; tools?: ToolSummary[]; relevantFiles?: string[]; usage?: Usage; promptContext?: string; waitingFor?: string
  progress?: Progress; filesGiven?: string[]; foundFiles?: number; permission?: Permission; question?: Question; signal?: Signal
}

export const crew: Worker[] = [
  {
    id: 'wren', name: 'Wren', action: 'approve db:migrate', task: "Fix the off-by-one date on the booking confirmation when the user's timezone is ahead of UTC", hue: 25, mark: 'bar', state: 'waiting', presentation: 'waiting', priority: 'P1', elapsed: '2m40', delay: '-.7s',
    repo: 'web-client', branch: 'fix/datepicker-tz', model: 'opus', effort: '▓▓▓▓', file: 'bookingDate.ts', path: 'src/booking/', edit: '+14 −6', fileTag: 'EDITING', tool: 'bash · pnpm test date', context: '98k / 200k ctx', cost: '$3.10', budget: 49,
    activity: [{ time: '11:39', text: '⏸ asking · db:migrate', current: true }, { time: '11:38', text: 'bash pnpm test date' }, { time: '11:36', text: 'edit bookingDate.ts +14 −6' }, { time: '11:34', text: 'read useSlots.ts' }],
    message: "The unit tests pass, but the stored column is timestamp not timestamptz — I'd like to migrate it before finishing.",
    permission: { command: 'pnpm db:migrate', question: 'Can I run {command} against the local booking DB? The fix changes a stored timestamp column type.' }
  },
  {
    id: 'moss', name: 'Moss', action: 'SettingsForm', task: 'Migrate the settings page to the new form library', hue: 150, mark: 'dot', state: 'working', presentation: 'working', priority: 'P2', elapsed: '18m', delay: '-2.2s',
    repo: 'web-client', branch: 'chore/settings-forms', model: 'sonnet', effort: '▓▓▓░', file: 'SettingsForm.tsx', path: 'src/settings/', edit: '+62 −40', fileTag: 'EDITING', tool: 'edit · SettingsForm.tsx', context: '62k / 200k ctx', cost: '$1.42', budget: 31,
    activity: [{ time: '11:41', text: 'edit SettingsForm.tsx', current: true }, { time: '11:40', text: 'read useFormState.ts' }, { time: '11:38', text: 'grep registerField' }, { time: '11:33', text: 'edit SettingsForm.tsx +62 −40' }],
    message: "Converted 4 of 7 fields. One validation rule has no equivalent yet — keeping the old validator for now and I'll flag it at the end.",
    progress: { percent: 57, label: '4 of 7 fields', touched: ['fields.ts', 'useFormState.ts', 'SettingsPage.tsx'], additionalTouched: 4 }, filesGiven: ['design-tokens.md', 'Figma spec.png'], foundFiles: 6
  },
  {
    id: 'dune', name: 'Dune', action: 'done · review', task: 'Consolidate the dark-mode design tokens', hue: 200, mark: 'square', state: 'done', presentation: 'done', priority: 'P3', elapsed: '34m', delay: '-1.4s',
    repo: 'web-client', branch: 'chore/dark-tokens', model: 'sonnet', effort: '▓▓▓░', file: 'tokens.css', path: 'src/theme/', edit: '+20 −12', fileTag: 'EDITING', tool: 'edit · tokens.css', context: '86k / 200k ctx', cost: '$2.26', budget: 43,
    activity: [{ time: '11:46', text: 'finished · ready for review', current: true }, { time: '11:44', text: 'edit tokens.css +20 −12' }, { time: '11:40', text: 'read theme.css' }, { time: '11:37', text: 'grep --color dark-mode' }],
    message: 'The token pass is complete and ready for review.', progress: { percent: 100, label: 'ready for review', touched: ['theme.css', 'colors.css'], additionalTouched: 2 }, filesGiven: ['design-tokens.md'], foundFiles: 4
  },
  {
    id: 'pike', name: 'Pike', action: 'stuck? same test ×6', task: 'Find why the checkout spec only fails on CI', hue: 250, mark: 'two', state: 'stuck', presentation: 'working', priority: 'P1', elapsed: '1h04', delay: '-3.2s',
    repo: 'e2e-suite', branch: 'spike/flaky-checkout', model: 'opus', effort: '▓▓▓▓', file: 'checkout.spec.ts', path: 'e2e/specs/', edit: 'no diff', fileTag: 'READING', tool: 'bash · pnpm test:e2e checkout', context: '128k / 200k ctx', cost: '$5.90', budget: 64,
    activity: [{ time: '11:42', text: 'bash pnpm test:e2e checkout', current: true }, { time: '11:39', text: 'read checkout.spec.ts' }, { time: '11:36', text: 'grep checkout complete' }, { time: '11:31', text: 'bash pnpm test:e2e checkout' }],
    message: 'The same checkout spec has repeated six times without a different result.', progress: { percent: 52, label: 'isolating CI behavior', touched: ['checkout.spec.ts', 'ci.yml'], additionalTouched: 1 }, filesGiven: ['ci-run-4821.log'], foundFiles: 3,
    signal: { kind: 'stuck', confidence: 61, evidence: 'The same test has repeated six times without a different result.' }
  },
  {
    id: 'tern', name: 'Tern', action: 'api-client', task: 'Make API retries consistent across the client', hue: 300, mark: 'diamond', state: 'drift', presentation: 'working', priority: 'P2', elapsed: '26m', delay: '-.2s',
    repo: 'web-client', branch: 'fix/retry-client', model: 'sonnet', effort: '▓▓▓░', file: 'refresh.ts', path: 'src/auth/', edit: '+35 −8', fileTag: 'EDITING', tool: 'edit · refresh.ts', context: '74k / 200k ctx', cost: '$1.96', budget: 37,
    activity: [{ time: '11:45', text: 'edit auth/refresh.ts', current: true }, { time: '11:43', text: 'read auth/session.ts' }, { time: '11:39', text: 'edit api-client/retry.ts' }, { time: '11:36', text: 'grep refreshToken' }],
    message: 'Four of the last six touched files are in auth, which may not relate to retry handling.', progress: { percent: 44, label: 'mapping retry paths', touched: ['auth/session.ts', 'auth/refresh.ts', 'api-client/retry.ts'], additionalTouched: 3 }, filesGiven: ['retry-notes.md'], foundFiles: 6,
    signal: { kind: 'drift', confidence: 61, evidence: "4 of the last 6 files are in src/auth/, which doesn't look related to this task.", files: [{ name: 'auth/session.ts' }, { name: 'auth/refresh.ts' }, { name: 'api-client/retry.ts', related: true }] }
  },
  {
    id: 'volt', name: 'Volt', action: 'vite build', task: 'Make the production build pass after the dependency update', hue: 60, mark: 'ring', state: 'working', presentation: 'working', priority: 'P3', elapsed: '9m', delay: '-2.8s',
    repo: 'web-client', branch: 'chore/deps', model: 'haiku', effort: '▓▓░░', file: 'vite.config.ts', path: 'config/', edit: '+2 −1', fileTag: 'EDITING', tool: 'bash · pnpm build', context: '24k / 200k ctx', cost: '$0.38', budget: 12,
    activity: [{ time: '11:46', text: 'bash pnpm build', current: true }, { time: '11:45', text: 'edit vite.config.ts +2 −1' }, { time: '11:43', text: 'read package.json' }, { time: '11:41', text: 'npm ls vite' }],
    message: 'The build is running against the updated dependency tree.', progress: { percent: 35, label: 'checking production build', touched: ['vite.config.ts', 'package.json'], additionalTouched: 1 }, filesGiven: ['build-output.txt'], foundFiles: 2
  }
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
