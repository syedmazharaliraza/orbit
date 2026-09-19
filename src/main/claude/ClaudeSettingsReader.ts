import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type ClaudeSettings = {
  model?: unknown
  env?: Record<string, unknown>
  effortLevel?: unknown
  modelSettings?: Record<string, { effortLevel?: unknown }>
}

/** Reads only the active effort configuration; never exposes raw settings. */
export class ClaudeSettingsReader {
  private readonly settingsPath = join(homedir(), '.claude', 'settings.json')
  private settings: ClaudeSettings | null | undefined

  async getEffort(model?: string): Promise<string | undefined> {
    const settings = await this.load()
    if (!settings) return undefined

    if (model && settings.modelSettings) {
      const matchingModel = Object.keys(settings.modelSettings)
        .sort((a, b) => b.length - a.length)
        .find(candidate => model === candidate || model.startsWith(`${candidate}-`))
      const modelEffort = matchingModel ? settings.modelSettings[matchingModel]?.effortLevel : undefined
      if (typeof modelEffort === 'string' && modelEffort.trim()) return modelEffort.trim().toLowerCase()
    }

    // A global effort is only meaningful once a model is known. Applying it
    // before model resolution can incorrectly turn a model-specific `low`
    // setting into the global `xhigh` value.
    if (!model) return undefined
    return typeof settings.effortLevel === 'string' && settings.effortLevel.trim()
      ? settings.effortLevel.trim().toLowerCase()
      : undefined
  }

  async getDefaultModel(): Promise<string | undefined> {
    const settings = await this.load()
    if (!settings) return undefined
    if (typeof settings.model === 'string' && settings.model.trim()) return settings.model.trim()

    const env = settings.env || {}
    for (const key of ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      const value = env[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }

    const modelKeys = Object.keys(settings.modelSettings || {})
    return modelKeys.length === 1 ? modelKeys[0] : undefined
  }

  private async load(): Promise<ClaudeSettings | null> {
    if (this.settings !== undefined) return this.settings
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf8')) as ClaudeSettings
      this.settings = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      this.settings = null
    }
    return this.settings
  }
}
