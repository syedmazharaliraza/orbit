import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeSessionStatus, DiscoveredSession, SessionMetadata } from '../types'
import type { NormalizedHookEvent } from './HookTypes'

const execFileAsync = promisify(execFile)

export class SessionRecovery {
  constructor(private readonly configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {}

  async snapshot(): Promise<DiscoveredSession[]> {
    const merged = new Map<string, DiscoveredSession>()
    try {
      const { stdout } = await execFileAsync('claude', ['agents', '--json'], { timeout: 5_000, maxBuffer: 1024 * 1024 })
      const parsed = JSON.parse(stdout || '[]') as unknown
      if (Array.isArray(parsed)) for (const item of parsed) { const session = normalizeSession(item); if (session) merged.set(session.sessionId, session) }
    } catch {
      // The registry snapshot below remains useful when Electron's PATH lacks Claude.
    }
    for (const session of await this.readRegistry()) if (!merged.has(session.sessionId)) merged.set(session.sessionId, session)
    return [...merged.values()]
  }

  registryPath(): string { return join(this.configRoot, 'sessions') }

  async readRegistry(): Promise<DiscoveredSession[]> {
    let names: string[]
    try { names = await readdir(this.registryPath()) } catch { return [] }
    const sessions = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.readMetadata(join(this.registryPath(), name))))
    return sessions.filter((session): session is DiscoveredSession => Boolean(session))
  }

  async readMetadata(path: string): Promise<DiscoveredSession | undefined> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) return undefined
      return normalizeSession(JSON.parse(await readFile(path, 'utf8')) as Partial<SessionMetadata>)
    } catch { return undefined }
  }

  /** Read-only liveness check used only after a registry/session snapshot gap. */
  async processExists(pid: number): Promise<boolean | undefined> {
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { timeout: 1_000, maxBuffer: 16 * 1024 })
      return stdout.trim() === String(pid)
    } catch (error) {
      const code = (error as { code?: number | string }).code
      if (code === 1) return false
      return undefined
    }
  }
}

/** Watches the tested registry directory; changes invalidate facts and trigger bounded reads. */
export class SessionRegistryObserver extends EventEmitter {
  private watcher: FSWatcher | undefined
  private pending = new Set<string>()
  private debounce: NodeJS.Timeout | undefined

  constructor(private readonly recovery: SessionRecovery) { super() }

  start(): void {
    try {
      this.watcher = watch(this.recovery.registryPath(), (_event, filename) => {
        if (!filename || !filename.endsWith('.json')) { this.emit('overflow'); return }
        this.pending.add(filename)
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.flush(), 80)
      })
      this.watcher.on('error', error => this.emit('error', error))
    } catch (error) { this.emit('unavailable', error) }
  }

  stop(): void { this.watcher?.close(); if (this.debounce) clearTimeout(this.debounce); this.removeAllListeners() }

  private async flush(): Promise<void> {
    const names = [...this.pending]; this.pending.clear(); this.debounce = undefined
    for (const name of names) {
      const session = await this.recovery.readMetadata(join(this.recovery.registryPath(), name))
      if (session) this.emit('session', session)
      else {
        const pid = Number(name.replace(/\.json$/, ''))
        if (Number.isInteger(pid) && pid > 0) this.emit('removed', pid)
      }
    }
  }
}

export function recoveryEvent(session: DiscoveredSession, sequence: number, kind: 'RecoverySnapshot' | 'MetadataChanged', configRootId: string): NormalizedHookEvent {
  const now = Date.now()
  return {
    schemaVersion: 1, eventId: `${kind}:${session.sessionId}:${sequence}`, installationId: 'orbit-local', configRootId,
    sessionId: session.sessionId, kind, source: kind === 'RecoverySnapshot' ? 'recovery' : 'metadata', collectorObservedAt: now,
    receiverReceivedAt: now, receiverSequence: sequence,
    data: { pid: session.pid, cwd: session.cwd, kind: session.kind, startedAt: session.startedAt, name: session.name, status: session.status, waitingFor: session.waitingFor },
    evidence: { classification: 'observed', correlation: 'session-only', completeness: 'partial', freshness: kind === 'RecoverySnapshot' ? 'recovered' : 'live' }
  }
}

export function missingRecoveryEvent(state: { sessionId: string; pid: number }, sequence: number, kind: 'RecoveryMissing' | 'ProcessExit', configRootId: string): NormalizedHookEvent {
  const now = Date.now()
  return {
    schemaVersion: 1, eventId: `${kind}:${state.sessionId}:${now}`, installationId: 'orbit-local', configRootId,
    sessionId: state.sessionId, kind, source: kind === 'ProcessExit' ? 'process-exit' : 'recovery', collectorObservedAt: now,
    receiverReceivedAt: now, receiverSequence: sequence, data: { pid: state.pid },
    evidence: { classification: 'observed', correlation: 'session-only', completeness: 'partial', freshness: 'live' }
  }
}

function normalizeSession(raw: unknown): DiscoveredSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Partial<SessionMetadata>
  if (typeof item.sessionId !== 'string' || typeof item.cwd !== 'string' || typeof item.pid !== 'number' || item.pid <= 0) return undefined
  const status = normalizeStatus(item.status)
  if (!status) return undefined
  return { pid: item.pid, cwd: item.cwd, kind: typeof item.kind === 'string' ? item.kind : 'interactive', startedAt: typeof item.startedAt === 'number' ? item.startedAt : Date.now(), sessionId: item.sessionId, name: typeof item.name === 'string' ? item.name : `session-${item.pid}`, status, waitingFor: typeof item.waitingFor === 'string' ? item.waitingFor : undefined }
}

function normalizeStatus(status: unknown): ClaudeSessionStatus | undefined { return status === 'busy' || status === 'idle' || status === 'waiting' ? status : undefined }
