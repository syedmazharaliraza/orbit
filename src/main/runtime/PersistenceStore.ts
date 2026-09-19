import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const positionSchema = z.object({ x: z.number(), y: z.number() }).optional()
const schema = z.object({
  version: z.literal(1),
  position: positionSchema
})

export type PersistedOrbitState = z.infer<typeof schema>

const empty = (): PersistedOrbitState => ({ version: 1 })

/** Durable Orbit presentation preferences only; session data never enters this file. */
export class PersistenceStore {
  private state: PersistedOrbitState = empty()

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedOrbitState> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')))
      this.state = parsed.success ? parsed.data : empty()
    } catch {
      this.state = empty()
    }
    return this.snapshot()
  }

  snapshot(): PersistedOrbitState {
    return structuredClone(this.state)
  }

  async update(change: Partial<PersistedOrbitState>): Promise<PersistedOrbitState> {
    this.state = schema.parse({ ...this.state, ...change, version: 1 })
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    await rename(temporaryPath, this.filePath)
    return this.snapshot()
  }
}
