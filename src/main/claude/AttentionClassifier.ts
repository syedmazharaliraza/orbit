/**
 * Stage 8 attention rules.
 *
 * This module only interprets facts already observed from Claude Code. It does
 * not inspect process health, infer intent, or claim that a worker is stuck or
 * drifting. Heuristic decisions always include the rule and evidence that
 * caused them so the renderer can present them as possibilities.
 */

import { isAbsolute, normalize, relative } from 'node:path'
import type { Worker, WorkerState, PresentationState, Priority, Signal } from '../../renderer/src/crew'
import type { ClaudeSessionState } from './types'

export const ATTENTION_RULES = {
  recentlyCompletedMs: 20_000,
  inactiveAfterMs: 45_000,
  repeatedToolMinimum: 3,
  repeatedToolWindow: 6
} as const

export type AttentionDecision = {
  state: WorkerState
  presentation: PresentationState
  priority: Priority
  signal?: Signal
}

export function classifySessionAttention(session: ClaudeSessionState, now = Date.now()): AttentionDecision {
  // A permission observation is stronger than all other attention signals.
  if (session.permission?.evidence === 'confirmed-waiting' || session.activityPhase === 'permission') {
    return { state: 'waiting', presentation: 'waiting', priority: 'P1' }
  }

  if (session.status === 'waiting' || session.activityPhase === 'waiting') {
    return { state: 'waiting', presentation: 'waiting', priority: 'P1' }
  }

  if (session.status === 'idle') {
    const sinceCompletion = session.lastToolFinishedAt ? now - session.lastToolFinishedAt : Number.POSITIVE_INFINITY
    if (sinceCompletion >= 0 && sinceCompletion <= ATTENTION_RULES.recentlyCompletedMs) {
      return { state: 'done', presentation: 'done', priority: 'P2' }
    }
    return { state: 'idle', presentation: 'idle', priority: 'P3' }
  }

  const drift = outsideProjectSignal(session)
  if (drift) return { state: 'drift', presentation: 'attention', priority: 'P2', signal: drift }

  const repeated = repeatedToolSignal(session)
  if (repeated) return { state: 'stuck', presentation: 'attention', priority: 'P1', signal: repeated }

  const inactive = inactiveSignal(session, now)
  if (inactive) return { state: 'stuck', presentation: 'attention', priority: 'P1', signal: inactive }

  return { state: 'working', presentation: 'working', priority: 'P2' }
}

function repeatedToolSignal(session: ClaudeSessionState): Signal | undefined {
  const activities = (session.activity || []).slice(-ATTENTION_RULES.repeatedToolWindow)
  const signatures = activities
    .map(activity => normalizeToolActivity(activity.text))
    .filter((text): text is string => Boolean(text))
  const latest = signatures.at(-1)
  if (!latest || !session.currentTool) return undefined

  const count = signatures.filter(signature => signature === latest).length
  if (count < ATTENTION_RULES.repeatedToolMinimum) return undefined

  return {
    kind: 'stuck',
    confidence: 62,
    heuristic: true,
    rule: `same observed tool activity at least ${ATTENTION_RULES.repeatedToolMinimum} times in the last ${ATTENTION_RULES.repeatedToolWindow} activity entries`,
    evidence: `The observed ${latest} action repeats ${count} times in recent transcript activity without a different tool action.`
  }
}

function inactiveSignal(session: ClaudeSessionState, now: number): Signal | undefined {
  if (!session.lastActivityAt) return undefined
  const inactiveFor = now - session.lastActivityAt
  if (inactiveFor < ATTENTION_RULES.inactiveAfterMs) return undefined

  return {
    kind: 'inactive',
    confidence: 58,
    heuristic: true,
    rule: `Claude Code reports busy and no transcript activity has been observed for at least ${ATTENTION_RULES.inactiveAfterMs / 1000}s`,
    evidence: `Claude Code still reports this session as busy, but Orbit has observed no transcript activity for ${Math.floor(inactiveFor / 1000)}s.`
  }
}

function outsideProjectSignal(session: ClaudeSessionState): Signal | undefined {
  const file = session.currentFile
  if (!file || !isAbsolute(file)) return undefined

  const project = normalize(session.cwd)
  const observed = normalize(file)
  const pathFromProject = relative(project, observed)
  const outside = pathFromProject === '..' || pathFromProject.startsWith('../') || isAbsolute(pathFromProject)
  if (!outside) return undefined

  return {
    kind: 'drift',
    confidence: 55,
    heuristic: true,
    rule: 'the current observed file path is outside the discovered session project directory',
    evidence: `The current observed path ${file} is outside the session project ${session.cwd}.`
  }
}

function normalizeToolActivity(text: string): string | undefined {
  const normalized = text
    .toLowerCase()
    .replace(/^›\s*/, '')
    .replace(/^finished\s*·\s*/, '')
    .trim()
  if (!normalized || normalized === 'assistant response' || normalized === 'waiting for user response' || normalized === 'tool finished') return undefined
  return normalized
}

// Keep this type-level reference close to the classifier so changes to the
// Worker attention surface fail the build instead of silently drifting apart.
export type AttentionWorkerState = Pick<Worker, 'state' | 'presentation' | 'priority' | 'signal'>
