import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PostModelSwitch',
  'CwdChanged', 'DirectoryAdded', 'ConfigChange', 'TaskCreated', 'TaskCompleted',
  'TeammateIdle'
] as const

export interface HookInstallerOptions {
  /** Path to Claude settings.json. Defaults to ~/.claude/settings.json */
  settingsPath?: string
  /** Path to Orbit observation root. Defaults to ~/Library/Application Support/Orbit/claude-observation */
  observationRoot?: string
  /** Path to the collector binary source. Must be provided. */
  collectorSource: string
  /** Where to install the collector binary. Defaults to observationRoot/bin/orbit-claude-hook-collector */
  collectorPath?: string
}

export interface HookInstallationResult {
  success: boolean
  message: string
  handlersAdded?: number
  settingsPath?: string
  collectorPath?: string
  inboxPath?: string
}

interface Settings {
  hooks?: {
    [event: string]: Array<{
      hooks: Array<{
        type: string
        command: string
        args: string[]
        timeout: number
      }>
      matcher?: string
    }>
  }
  [key: string]: unknown
}

/**
 * Checks if Orbit hooks are already installed in Claude Code settings.
 */
export async function areHooksInstalled(options?: Pick<HookInstallerOptions, 'settingsPath' | 'observationRoot'>): Promise<boolean> {
  const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const settingsPath = options?.settingsPath || join(configRoot, 'settings.json')
  const observationRoot = options?.observationRoot || join(homedir(), 'Library', 'Application Support', 'Orbit', 'claude-observation')
  const collectorPath = join(observationRoot, 'bin', 'orbit-claude-hook-collector')

  try {
    // Check if settings file exists and has hooks
    const settingsText = await readFile(settingsPath, 'utf8')
    const settings: Settings = JSON.parse(settingsText)

    if (!settings.hooks || typeof settings.hooks !== 'object') return false

    // Check if any of our events have handlers pointing to the collector
    const hasOrbitHandlers = EVENTS.some(event => {
      const groups = settings.hooks?.[event]
      if (!Array.isArray(groups)) return false
      return groups.some(group =>
        Array.isArray(group?.hooks) &&
        group.hooks.some(h => h.command === collectorPath)
      )
    })

    if (!hasOrbitHandlers) return false

    // Check if collector binary exists and is executable
    const collectorStat = await stat(collectorPath)
    if (!collectorStat.isFile() || (collectorStat.mode & 0o111) === 0) return false

    return true
  } catch {
    return false
  }
}

/**
 * Installs Orbit hooks into Claude Code settings.
 */
export async function installHooks(options: HookInstallerOptions): Promise<HookInstallationResult> {
  try {
    const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const settingsPath = options.settingsPath || join(configRoot, 'settings.json')
    const observationRoot = options.observationRoot || join(homedir(), 'Library', 'Application Support', 'Orbit', 'claude-observation')
    const collectorPath = options.collectorPath || join(observationRoot, 'bin', 'orbit-claude-hook-collector')
    const inboxPath = join(observationRoot, 'inbox')
    const manifestPath = join(observationRoot, 'hook-manifest.json')

    if (!isAbsolute(collectorPath)) {
      return { success: false, message: 'Collector path must be absolute.' }
    }

    if (collectorPath.includes('\0') || inboxPath.includes('\0')) {
      return { success: false, message: 'Paths contain invalid characters.' }
    }

    // Verify collector source exists and is executable
    try {
      const sourceStat = await stat(options.collectorSource)
      if (!sourceStat.isFile() || (sourceStat.mode & 0o111) === 0) {
        return { success: false, message: 'Collector source is missing or not executable.' }
      }
    } catch (error) {
      return { success: false, message: `Cannot access collector source: ${error instanceof Error ? error.message : String(error)}` }
    }

    // Read existing settings
    const original = await readSettings(settingsPath)
    const originalHash = digest(original.text)
    const settings = structuredClone(original.value)

    // Install hooks
    const handlersAdded = install(settings, collectorPath, inboxPath)

    if (handlersAdded === 0) {
      return {
        success: true,
        message: 'Hooks already installed.',
        handlersAdded: 0,
        settingsPath,
        collectorPath,
        inboxPath
      }
    }

    // Create directories
    await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 })
    await mkdir(observationRoot, { recursive: true, mode: 0o700 })
    await mkdir(inboxPath, { recursive: true, mode: 0o700 })
    await chmod(observationRoot, 0o700).catch(() => undefined)
    await chmod(inboxPath, 0o700).catch(() => undefined)

    // Copy collector binary
    await mkdir(dirname(collectorPath), { recursive: true, mode: 0o700 })
    const stagedCollector = join(dirname(collectorPath), `.collector-${process.pid}-${randomUUID()}.tmp`)
    await copyFile(options.collectorSource, stagedCollector)
    await chmod(stagedCollector, 0o700)
    await rename(stagedCollector, collectorPath)

    // Verify settings haven't changed
    const currentText = await readFile(settingsPath, 'utf8').catch(error =>
      error.code === 'ENOENT' ? '{}' : Promise.reject(error)
    )
    if (digest(currentText) !== originalHash) {
      return { success: false, message: 'Claude settings changed during setup. Please retry.' }
    }

    // Backup existing settings
    if (original.exists) {
      const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
      const backupPath = `${settingsPath}.orbit-backup-${timestamp}`
      await copyFile(settingsPath, backupPath)
      await chmod(backupPath, 0o600)
    }

    // Write updated settings atomically
    const temporary = join(dirname(settingsPath), `.settings.orbit-${process.pid}-${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await rename(temporary, settingsPath)
    await chmod(settingsPath, original.mode ?? 0o600)

    // Write manifest
    const ownedHandlers = EVENTS.map(event => ({
      event,
      handler: handler(event, collectorPath, inboxPath)
    }))
    await writeAtomic(manifestPath, {
      schemaVersion: 1,
      settingsPath,
      collectorPath,
      inboxPath,
      ownedHandlers,
      installedAt: Date.now()
    })

    return {
      success: true,
      message: `Successfully installed ${handlersAdded} hook handler${handlersAdded === 1 ? '' : 's'}.`,
      handlersAdded,
      settingsPath,
      collectorPath,
      inboxPath
    }
  } catch (error) {
    return {
      success: false,
      message: `Hook installation failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function install(settings: Settings, collectorPath: string, inboxPath: string): number {
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('The existing hooks value is not an object.')
  }

  settings.hooks ||= {}
  let additions = 0

  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : (settings.hooks[event] = [])
    const owned = handler(event, collectorPath, inboxPath)
    const exists = groups.some(group =>
      Array.isArray(group?.hooks) &&
      group.hooks.some(candidate => sameHandler(candidate, owned))
    )

    if (exists) continue

    groups.push(
      event === 'Notification'
        ? { matcher: 'permission_prompt|elicitation_dialog', hooks: [owned] }
        : { hooks: [owned] }
    )
    additions++
  }

  return additions
}

function handler(event: string, collectorPath: string, inboxPath: string) {
  return {
    type: 'command',
    command: collectorPath,
    args: ['observe', '--schema', '1', '--event', event, '--inbox', inboxPath],
    timeout: 1
  }
}

function sameHandler(candidate: unknown, owned: ReturnType<typeof handler>): boolean {
  if (!candidate || typeof candidate !== 'object') return false
  const c = candidate as Record<string, unknown>
  return (
    c.type === owned.type &&
    c.command === owned.command &&
    c.timeout === owned.timeout &&
    JSON.stringify(c.args) === JSON.stringify(owned.args)
  )
}

async function readSettings(path: string) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Claude settings must contain a JSON object.')
    }
    return {
      text,
      value: parsed as Settings,
      exists: true,
      mode: (await stat(path)).mode & 0o777
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: '{}', value: {} as Settings, exists: false, mode: 0o600 }
    }
    throw error
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.manifest-${process.pid}-${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
