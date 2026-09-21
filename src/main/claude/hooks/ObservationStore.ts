import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ObservationCheckpoint<T = unknown> {
  schemaVersion: 1
  receiverSequence: number
  processedEventIds: string[]
  reducer: T
  /** Bounded, minimized observations used for diagnostics and deterministic audit. */
  events?: unknown[]
  savedAt: number
}

export class ObservationStore<T> {
  private readonly checkpointPath: string

  constructor(private readonly root: string) {
    this.checkpointPath = join(root, 'checkpoint.json')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700).catch(() => undefined)
  }

  async load(): Promise<ObservationCheckpoint<T> | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.checkpointPath, 'utf8')) as ObservationCheckpoint<T>
      return parsed.schemaVersion === 1 ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async save(checkpoint: ObservationCheckpoint<T>): Promise<void> {
    const temporary = join(dirname(this.checkpointPath), `.checkpoint-${process.pid}-${Date.now()}.tmp`)
    await writeFile(temporary, JSON.stringify(checkpoint), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, this.checkpointPath)
    await chmod(this.checkpointPath, 0o600).catch(() => undefined)
  }
}
