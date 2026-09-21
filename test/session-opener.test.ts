import assert from 'node:assert/strict'
import { SessionOpener, parseProcessTable, terminalFocusScript, itermFocusScript } from '../src/main/claude/SessionOpener'

async function main() {
  const table = `  501     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  700   501 /bin/zsh
  701   700 /Users/test/.local/bin/claude
`
  const parsed = parseProcessTable(table)
  assert.equal(parsed.get(701)?.command, '/Users/test/.local/bin/claude')

  const terminalCalls: Array<{ file: string; args: string[] }> = []
  const terminal = new SessionOpener(async (file, args) => {
    terminalCalls.push({ file, args })
    if (file === '/bin/ps') return { stdout: args[0] === '-p' ? 'ttys007\n' : table, stderr: '' }
    if (file === '/usr/bin/osascript') return { stdout: 'focused\n', stderr: '' }
    if (file === '/usr/bin/open') return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${file}`)
  })
  assert.deepEqual(await terminal.focus(701), { ok: true, mode: 'terminal', message: 'Focused Claude Code session.' })
  assert.deepEqual(terminalCalls[1], { file: '/bin/ps', args: ['-p', '701', '-o', 'tty='] })
  assert.deepEqual(terminalCalls[2], { file: '/usr/bin/osascript', args: ['-e', terminalFocusScript, '/dev/ttys007'] })
  assert.equal(terminalCalls.some(call => call.file === '/usr/bin/open'), false, 'exact tab navigation must not open a generic window')

  const iterm = new SessionOpener(async (file, args) => {
    if (file === '/bin/ps') return { stdout: args[0] === '-p' ? 'ttys009' : table.replace('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', '/Applications/iTerm.app/Contents/MacOS/iTerm2'), stderr: '' }
    assert.deepEqual(args, ['-e', itermFocusScript, '/dev/ttys009'])
    return { stdout: 'focused', stderr: '' }
  })
  assert.equal((await iterm.focus(701)).mode, 'terminal')

  for (const outcome of ['missing', 'denied']) {
    const unavailable = new SessionOpener(async (file, args) => {
      if (file === '/bin/ps') return { stdout: args[0] === '-p' ? 'ttys007' : table, stderr: '' }
      assert.equal(file, '/usr/bin/osascript')
      if (outcome === 'denied') throw new Error('Automation denied')
      return { stdout: outcome, stderr: '' }
    })
    assert.equal((await unavailable.focus(701)).ok, false, 'do not silently navigate to the wrong tab')
  }
  const stale = new SessionOpener(async () => ({ stdout: table.replace('/Users/test/.local/bin/claude', '/bin/zsh'), stderr: '' }))
  assert.equal((await stale.focus(701)).ok, false)
  assert.equal((await stale.focus(999)).ok, false)
  assert.equal((await stale.focus(0)).ok, false)

  // Hosts without a tab interface still use the existing application fallback.
  const editorTable = `  900     1 /Applications/Acme Studio.app/Contents/MacOS/Acme Studio
  901   900 Acme Helper (Plugin): extension-host
  902   901 /Users/test/.local/bin/claude
`
  const editorCalls: Array<{ file: string; args: string[] }> = []
  const editor = new SessionOpener(async (file, args) => {
    editorCalls.push({ file, args })
    if (file === '/bin/ps') return { stdout: editorTable, stderr: '' }
    if (file === '/usr/bin/open') return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${file}`)
  })
  assert.deepEqual(await editor.focus(902), { ok: true, mode: 'application', message: 'Focused Acme Studio.' })
  assert.deepEqual(editorCalls[1], { file: '/usr/bin/open', args: ['/Applications/Acme Studio.app'] })

  // Prefer the outer UI owner over an embedded CLI application bundle.
  const nestedTable = `74727     1 /Applications/Host Shell.app/Contents/MacOS/Host Shell
76276 74727 /Applications/Host Shell.app/Contents/Helpers/launcher
76277 76276 /Users/test/Library/Application Support/vendor/cli.app/Contents/MacOS/claude
`
  const nestedCalls: Array<{ file: string; args: string[] }> = []
  const nested = new SessionOpener(async (file, args) => {
    nestedCalls.push({ file, args })
    if (file === '/bin/ps') return { stdout: nestedTable, stderr: '' }
    if (file === '/usr/bin/open') return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${file}`)
  })
  assert.deepEqual(await nested.focus(76277), { ok: true, mode: 'application', message: 'Focused Host Shell.' })
  assert.deepEqual(nestedCalls[1], { file: '/usr/bin/open', args: ['/Applications/Host Shell.app'] })

  console.log('session opener tests passed')
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
