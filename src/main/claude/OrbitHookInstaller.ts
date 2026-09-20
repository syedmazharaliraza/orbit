import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

const ORBIT_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PermissionRequest',
  'PermissionDenied',
  'Elicitation',
  'ElicitationResult',
  'PostModelSwitch',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'MessageDisplay'
] as const

type OrbitHookEvent = (typeof ORBIT_HOOK_EVENTS)[number]

interface HookConfig {
  type: string
  url: string
  async: boolean
  timeout: number
  statusMessage?: string
}

interface SettingsJson {
  hooks?: Record<string, HookConfig[]>
  [key: string]: unknown
}

const ORBIT_HOOK_MARKER = 'orbit-hook'
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 100

export class OrbitHookInstaller {
  constructor(private port: number) {}

  async install(): Promise<void> {
    console.log(`[OrbitHookInstaller] Installing hooks for port ${this.port}`)

    await this.withRetry(async () => {
      const settings = await this.readSettings()

      // Ensure hooks object exists
      if (!settings.hooks) {
        settings.hooks = {}
      }

      // Install ORBIT hook for each event
      for (const eventName of ORBIT_HOOK_EVENTS) {
        if (!settings.hooks[eventName]) {
          settings.hooks[eventName] = []
        }

        // Remove existing ORBIT hooks for this event (cleanup from previous run)
        settings.hooks[eventName] = settings.hooks[eventName].filter(
          (hook) => hook.statusMessage !== ORBIT_HOOK_MARKER
        )

        // Add new ORBIT hook
        settings.hooks[eventName].push({
          type: 'http',
          url: `http://localhost:${this.port}/hooks`,
          async: true,
          timeout: 5,
          statusMessage: ORBIT_HOOK_MARKER
        })
      }

      await this.writeSettings(settings)
    })

    console.log(`[OrbitHookInstaller] Installed ${ORBIT_HOOK_EVENTS.length} hooks`)
  }

  async uninstall(): Promise<void> {
    console.log('[OrbitHookInstaller] Uninstalling hooks')

    try {
      await this.withRetry(async () => {
        const settings = await this.readSettings()

        if (!settings.hooks) {
          console.log('[OrbitHookInstaller] No hooks found in settings.json')
          return
        }

        // Remove ORBIT hooks from each event
        let removedCount = 0
        for (const eventName of ORBIT_HOOK_EVENTS) {
          if (settings.hooks[eventName]) {
            const beforeCount = settings.hooks[eventName].length
            settings.hooks[eventName] = settings.hooks[eventName].filter(
              (hook) => hook.statusMessage !== ORBIT_HOOK_MARKER
            )
            const afterCount = settings.hooks[eventName].length
            removedCount += beforeCount - afterCount

            // Clean up empty arrays
            if (settings.hooks[eventName].length === 0) {
              delete settings.hooks[eventName]
            }
          }
        }

        // Clean up empty hooks object
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks
        }

        await this.writeSettings(settings)
        console.log(`[OrbitHookInstaller] Removed ${removedCount} hooks`)
      })
    } catch (err) {
      console.error('[OrbitHookInstaller] Failed to uninstall hooks:', err)
      // Don't throw - best effort cleanup
    }
  }

  private async readSettings(): Promise<SettingsJson> {
    try {
      const content = await fs.readFile(SETTINGS_PATH, 'utf-8')
      return JSON.parse(content) as SettingsJson
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        // Settings file doesn't exist - create with empty object
        console.log('[OrbitHookInstaller] settings.json not found, will create')
        return {}
      }
      throw err
    }
  }

  private async writeSettings(settings: SettingsJson): Promise<void> {
    // Ensure .claude directory exists
    const claudeDir = path.dirname(SETTINGS_PATH)
    await fs.mkdir(claudeDir, { recursive: true })

    // Write with pretty formatting
    const content = JSON.stringify(settings, null, 2) + '\n'
    await fs.writeFile(SETTINGS_PATH, content, 'utf-8')
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastError = err as Error
        console.warn(
          `[OrbitHookInstaller] Attempt ${attempt}/${MAX_RETRIES} failed:`,
          lastError.message
        )

        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt))
        }
      }
    }

    throw lastError
  }
}
