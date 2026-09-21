import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export type OpenSessionResult = {
  ok: boolean
  mode?: 'application'
  message: string
}

type CommandResult = { stdout: string; stderr: string }
type CommandRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<CommandResult>
type ProcessEntry = { pid: number; ppid: number; command: string }
type ApplicationHost = { applicationPath: string; label: string }

const defaultRunner: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(error)
    else resolve({ stdout, stderr })
  })
})

/** Focuses the existing application that owns a session process. It never starts or resumes Claude. */
export class SessionOpener {
  constructor(private readonly run: CommandRunner = defaultRunner) {}

  async focus(pid: number): Promise<OpenSessionResult> {
    if (process.platform !== 'darwin') return { ok: false, message: 'Opening an existing session is currently supported on macOS only.' }
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, message: 'Orbit has not verified a process for this session yet.' }

    let processes: Map<number, ProcessEntry>
    try {
      const result = await this.run('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 1_500, maxBuffer: 2 * 1024 * 1024 })
      processes = parseProcessTable(result.stdout)
    } catch {
      return { ok: false, message: 'Orbit could not inspect the session process.' }
    }

    const sessionProcess = processes.get(pid)
    if (!sessionProcess) return { ok: false, message: 'The Claude process is no longer running.' }
    if (!/(?:^|\/)claude(?:$|\s)|Claude Code/i.test(sessionProcess.command)) {
      return { ok: false, message: 'The stored process identity no longer matches Claude.' }
    }

    const chain = processChain(sessionProcess, processes)
    const host = applicationHost(chain)
    if (!host) return { ok: false, message: 'Orbit could not identify the app hosting this session.' }

    try {
      await this.run('/usr/bin/open', [host.applicationPath], { timeout: 2_000, maxBuffer: 16 * 1024 })
      return { ok: true, mode: 'application', message: `Focused ${host.label}.` }
    } catch {
      return { ok: false, message: `Orbit could not focus ${host.label}. Check macOS app permissions.` }
    }
  }
}

export function parseProcessTable(output: string): Map<number, ProcessEntry> {
  const result = new Map<number, ProcessEntry>()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) continue
    result.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return result
}

function processChain(start: ProcessEntry, processes: Map<number, ProcessEntry>): ProcessEntry[] {
  const result: ProcessEntry[] = []
  const seen = new Set<number>()
  let current: ProcessEntry | undefined = start
  while (current && result.length < 32 && !seen.has(current.pid)) {
    result.push(current); seen.add(current.pid); current = processes.get(current.ppid)
  }
  return result
}

/**
 * Finds the outermost application bundle in the process ancestry. The leaf can itself
 * live in an embedded .app (for example, a packaged CLI), so the furthest ancestor
 * with an application bundle is the UI owner.
 */
function applicationHost(chain: ProcessEntry[]): ApplicationHost | undefined {
  let applicationPath: string | undefined
  for (const entry of chain) {
    const candidate = entry.command.match(/^(\/.*?\.app)(?:\/|$)/i)?.[1]
    if (candidate) applicationPath = candidate
  }
  if (!applicationPath) return undefined
  return { applicationPath, label: basename(applicationPath, '.app') || 'host application' }
}
