import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export type OpenSessionResult = {
  ok: boolean
  mode?: 'application' | 'terminal'
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

    // Terminal and iTerm expose the PTY of each tab/pane. Select by device,
    // never by a title that can be shared by several workers.
    const script = host.label === 'Terminal' ? terminalFocusScript : /^iTerm2?$/.test(host.label) ? itermFocusScript : undefined
    if (script) {
      try {
        const { stdout } = await this.run('/bin/ps', ['-p', String(pid), '-o', 'tty='], { timeout: 1_500, maxBuffer: 16 * 1024 })
        const tty = stdout.trim().replace(/^\/dev\//, '')
        if (/^ttys?\d+$/.test(tty)) {
          const focused = await this.run('/usr/bin/osascript', ['-e', script, `/dev/${tty}`], { timeout: 5_000, maxBuffer: 16 * 1024 })
          if (focused.stdout.trim() === 'focused') return { ok: true, mode: 'terminal', message: 'Focused Claude Code session.' }
          return { ok: false, message: `Could not find this session’s tab in ${host.label}.` }
        }
      } catch {
        return { ok: false, message: `Allow Orbit to control ${host.label} in macOS Automation settings to focus this session.` }
      }
    }

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

// Arguments carry the device path as data; no session content becomes AppleScript.
export const terminalFocusScript = `on run argv
  tell application id "com.apple.Terminal"
    repeat with hostWindow in windows
      repeat with hostTab in tabs of hostWindow
        if tty of hostTab is item 1 of argv then
          set selected of hostTab to true
          set miniaturized of hostWindow to false
          set index of hostWindow to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`

export const itermFocusScript = `on run argv
  tell application id "com.googlecode.iterm2"
    repeat with hostWindow in windows
      repeat with hostTab in tabs of hostWindow
        repeat with hostSession in sessions of hostTab
          if tty of hostSession is item 1 of argv then
            set miniaturized of hostWindow to false
            select hostWindow
            select hostTab
            select hostSession
            activate
            return "focused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`
