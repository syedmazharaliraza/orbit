import assert from 'node:assert/strict'
import { SessionOpener, parseProcessTable } from '../src/main/claude/SessionOpener'

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
    if (file === '/bin/ps') return { stdout: table, stderr: '' }
    if (file === '/usr/bin/open') return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${file}`)
  })
  assert.deepEqual(await terminal.focus(701), { ok: true, mode: 'application', message: 'Focused Terminal.' })
  assert.deepEqual(terminalCalls[1], { file: '/usr/bin/open', args: ['/System/Applications/Utilities/Terminal.app'] })

  // No application names are known to SessionOpener. Any .app-backed host works.
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
