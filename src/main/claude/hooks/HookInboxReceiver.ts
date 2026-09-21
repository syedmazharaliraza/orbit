import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CollectorRecord } from './HookTypes'

const MAX_RECORD_BYTES = 64 * 1024

/** Drains atomically committed collector records. fs.watch is only a wake hint. */
export class HookInboxReceiver extends EventEmitter {
  private watcher: FSWatcher | undefined
  private draining = false
  private drainAgain = false

  constructor(readonly inboxPath: string) { super() }

  async start(): Promise<void> {
    await mkdir(this.inboxPath, { recursive: true, mode: 0o700 })
    await chmod(this.inboxPath, 0o700).catch(() => undefined)
    this.watcher = watch(this.inboxPath, () => void this.drain())
    this.watcher.on('error', error => this.emit('error', error))
    await this.drain()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.removeAllListeners()
  }

  async drain(): Promise<void> {
    if (this.draining) { this.drainAgain = true; return }
    this.draining = true
    try {
      do {
        this.drainAgain = false
        let names: string[] = []
        try { names = (await readdir(this.inboxPath)).filter(name => name.endsWith('.json')).sort() } catch { return }
        for (const name of names) await this.consume(join(this.inboxPath, name))
      } while (this.drainAgain)
    } finally {
      this.draining = false
    }
  }

  private async consume(path: string): Promise<void> {
    try {
      if (basename(path).startsWith('.')) return
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.size > MAX_RECORD_BYTES) {
        this.emit('invalid-record', path)
        await unlink(path).catch(() => undefined)
        return
      }
      const record = JSON.parse(await readFile(path, 'utf8')) as CollectorRecord
      await new Promise<void>((resolve, reject) => {
        this.emit('record', record, path, (error?: Error) => error ? reject(error) : resolve())
      })
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('error', error)
    }
  }
}
