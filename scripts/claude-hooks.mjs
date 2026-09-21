#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PostModelSwitch',
  'CwdChanged', 'DirectoryAdded', 'ConfigChange', 'TaskCreated', 'TaskCompleted',
  'TeammateIdle'
]

const argv = process.argv.slice(2)
const valueAfter = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined }
const mode = argv.includes('--apply') ? 'apply' : argv.includes('--uninstall') ? 'uninstall' : 'preview'
const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const settingsPath = resolve(valueAfter('--settings') || join(configRoot, 'settings.json'))
const observationRoot = resolve(valueAfter('--observation-root') || join(homedir(), 'Library', 'Application Support', 'Orbit', 'claude-observation'))
const collectorSource = resolve(valueAfter('--collector') || join(process.cwd(), '.build', 'orbit-claude-hook-collector'))
const collectorPath = resolve(valueAfter('--installed-collector') || join(observationRoot, 'bin', 'orbit-claude-hook-collector'))
const inboxPath = join(observationRoot, 'inbox')
const manifestPath = join(observationRoot, 'hook-manifest.json')

if (!isAbsolute(collectorPath)) fail('Collector path must be absolute.')
if (collectorPath.includes('\0') || inboxPath.includes('\0')) fail('Paths contain invalid characters.')

const original = await readSettings(settingsPath)
const originalHash = digest(original.text)
const settings = structuredClone(original.value)
const manifest = mode === 'uninstall' ? await readManifest() : undefined

let changed = 0
if (mode === 'uninstall') changed = uninstall(settings, manifest)
else changed = install(settings)

const action = mode === 'uninstall' ? 'remove' : 'add'
console.log(`Orbit Claude hooks ${mode}: ${action} ${changed} owned handler${changed === 1 ? '' : 's'}.`)
console.log(`Settings: ${settingsPath}`)
console.log(`Collector source: ${collectorSource}`)
console.log(`Stable collector: ${collectorPath}`)
console.log(`Inbox: ${inboxPath}`)
console.log(`Events: ${EVENTS.join(', ')}`)
if (mode === 'preview') {
  console.log('No files changed. Re-run with --apply after reviewing these paths and events.')
  process.exit(0)
}
if (changed === 0) {
  console.log('No settings changes were needed.')
  process.exit(0)
}

if (mode === 'apply') await verifyCollector()
await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 })
await mkdir(observationRoot, { recursive: true, mode: 0o700 })
await mkdir(inboxPath, { recursive: true, mode: 0o700 })
await chmod(observationRoot, 0o700).catch(() => undefined)
await chmod(inboxPath, 0o700).catch(() => undefined)

if (mode === 'apply') {
  await mkdir(dirname(collectorPath), { recursive: true, mode: 0o700 })
  const stagedCollector = join(dirname(collectorPath), `.collector-${process.pid}-${randomUUID()}.tmp`)
  await copyFile(collectorSource, stagedCollector)
  await chmod(stagedCollector, 0o700)
  await rename(stagedCollector, collectorPath)
}

const currentText = await readFile(settingsPath, 'utf8').catch(error => error.code === 'ENOENT' ? '{}' : Promise.reject(error))
if (digest(currentText) !== originalHash) fail('Claude settings changed during setup; nothing was written. Re-run against the latest file.')

const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const backupPath = `${settingsPath}.orbit-backup-${timestamp}`
if (original.exists) {
  await copyFile(settingsPath, backupPath)
  await chmod(backupPath, 0o600)
}
const temporary = join(dirname(settingsPath), `.settings.orbit-${process.pid}-${randomUUID()}.tmp`)
await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
await rename(temporary, settingsPath)
await chmod(settingsPath, original.mode ?? 0o600)

if (mode === 'apply') {
  const ownedHandlers = EVENTS.map(event => ({ event, handler: handler(event) }))
  await writeAtomic(manifestPath, { schemaVersion: 1, settingsPath, collectorPath, inboxPath, ownedHandlers, installedAt: Date.now() })
} else {
  await writeAtomic(manifestPath, { schemaVersion: 1, settingsPath, collectorPath, inboxPath, ownedHandlers: [], uninstalledAt: Date.now() })
}

console.log(`Updated Claude settings atomically.${original.exists ? ` Backup: ${backupPath}` : ''}`)

function install(settings) {
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) fail('The existing hooks value is not an object; settings were not changed.')
  settings.hooks ||= {}
  let additions = 0
  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : (settings.hooks[event] = [])
    const owned = handler(event)
    const exists = groups.some(group => Array.isArray(group?.hooks) && group.hooks.some(candidate => sameHandler(candidate, owned)))
    if (exists) continue
    groups.push(event === 'Notification' ? { matcher: 'permission_prompt|elicitation_dialog', hooks: [owned] } : { hooks: [owned] })
    additions++
  }
  return additions
}

function uninstall(settings, saved) {
  if (!saved || saved.settingsPath !== settingsPath || !Array.isArray(saved.ownedHandlers)) fail('No matching Orbit hook manifest was found; settings were not changed.')
  if (!settings.hooks || typeof settings.hooks !== 'object') return 0
  let removals = 0
  for (const entry of saved.ownedHandlers) {
    if (!EVENTS.includes(entry.event) || !Array.isArray(settings.hooks[entry.event])) continue
    settings.hooks[entry.event] = settings.hooks[entry.event].flatMap(group => {
      if (!Array.isArray(group?.hooks)) return [group]
      const kept = group.hooks.filter(candidate => {
        const owned = sameHandler(candidate, entry.handler)
        if (owned) removals++
        return !owned
      })
      return kept.length ? [{ ...group, hooks: kept }] : []
    })
    if (settings.hooks[entry.event].length === 0) delete settings.hooks[entry.event]
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  return removals
}

function handler(event) {
  return { type: 'command', command: collectorPath, args: ['observe', '--schema', '1', '--event', event, '--inbox', inboxPath], timeout: 1 }
}

function sameHandler(candidate, owned) {
  return candidate && candidate.type === owned.type && candidate.command === owned.command && candidate.timeout === owned.timeout && JSON.stringify(candidate.args) === JSON.stringify(owned.args)
}

async function readSettings(path) {
  try {
    const text = await readFile(path, 'utf8')
    assertNoDuplicateKeys(text)
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Claude settings must contain a JSON object.')
    return { text, value: parsed, exists: true, mode: (await stat(path)).mode & 0o777 }
  } catch (error) {
    if (error.code === 'ENOENT') return { text: '{}', value: {}, exists: false, mode: 0o600 }
    fail(`Cannot safely read Claude settings: ${error.message}`)
  }
}

async function readManifest() {
  try { return JSON.parse(await readFile(manifestPath, 'utf8')) } catch { return undefined }
}

async function verifyCollector() {
  const metadata = await stat(collectorSource).catch(() => undefined)
  if (!metadata?.isFile() || (metadata.mode & 0o111) === 0) fail('Collector is missing or not executable. Run npm run build:collector first.')
}

async function writeAtomic(path, value) {
  const temporary = join(dirname(path), `.manifest-${process.pid}-${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function digest(text) { return createHash('sha256').update(text).digest('hex') }
function fail(message) { console.error(message); process.exit(1) }

// A small structural scan rejects duplicate object keys before JSON.parse can
// silently collapse them. JSON.parse still performs the authoritative syntax check.
function assertNoDuplicateKeys(source) {
  let index = 0
  const whitespace = () => { while (/\s/.test(source[index] || '')) index++ }
  const string = () => {
    const start = index++
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue }
      if (source[index++] === '"') return JSON.parse(source.slice(start, index))
    }
    throw new Error('Unterminated JSON string')
  }
  const primitive = () => { while (index < source.length && !/[\s,}\]]/.test(source[index])) index++ }
  const value = () => {
    whitespace()
    if (source[index] === '{') return object()
    if (source[index] === '[') return array()
    if (source[index] === '"') { string(); return }
    primitive()
  }
  const object = () => {
    index++; whitespace(); const keys = new Set()
    if (source[index] === '}') { index++; return }
    while (index < source.length) {
      whitespace(); if (source[index] !== '"') throw new Error('Invalid object key')
      const key = string(); if (keys.has(key)) throw new Error(`Duplicate settings key: ${key}`); keys.add(key)
      whitespace(); if (source[index++] !== ':') throw new Error('Invalid object separator')
      value(); whitespace()
      if (source[index] === '}') { index++; return }
      if (source[index++] !== ',') throw new Error('Invalid object delimiter')
    }
  }
  const array = () => {
    index++; whitespace(); if (source[index] === ']') { index++; return }
    while (index < source.length) { value(); whitespace(); if (source[index] === ']') { index++; return }; if (source[index++] !== ',') throw new Error('Invalid array delimiter') }
  }
  value()
}
