/**
 * ConversationTranscriptTailer - Tails conversation transcript JSONL files
 *
 * Responsibilities:
 * - Watch transcript file with fs.watch() and process new content
 * - Maintain byte-offset checkpoint for incremental parsing
 * - Parse only new events (not entire file)
 * - Extract tool calls, file activity, tokens, task updates
 * - Fallback to polling if fs.watch() unreliable
 */

import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  TranscriptCheckpoint,
  TranscriptEvent,
  LastPromptEvent,
  AssistantMessageEvent,
  UserMessageEvent,
  TokenReminderAttachment,
  ToolUseBlock,
  ToolResultBlock,
  ObservedQuestionRequest,
  ObservedQuestion
} from './types'

export class ConversationTranscriptTailer extends EventEmitter {
  // A restarted Orbit instance only needs the recent transcript to rebuild a
  // live card. The history file supplies prompt context; keeping replay bounded
  // prevents a months-old session from loading its entire JSONL into memory.
  private static readonly MAX_INITIAL_REPLAY_BYTES = 4 * 1024 * 1024
  private checkpoint: TranscriptCheckpoint
  private watcher: FSWatcher | null = null
  private pollInterval: NodeJS.Timeout | null = null
  private transcriptPath: string
  private consecutiveParseErrors = 0
  private debounceTimeout: NodeJS.Timeout | null = null
  private tailInProgress = false
  private tailQueued = false
  private partialLine = ''

  constructor(
    private sessionId: string,
    projectPath: string,
    private useFilesystemWatching = true
  ) {
    super()
    this.transcriptPath = this.buildTranscriptPath(projectPath)
    this.checkpoint = {
      sessionId,
      byteOffset: 0,
      lastEventUuid: null,
      lastUpdated: Date.now()
    }
  }

  /**
   * Start tailing the transcript file
   */
  async start(): Promise<void> {
    // Try initial tail to catch up with existing content
    await this.prepareInitialCheckpoint()
    await this.tail()

    // Set up filesystem watching if enabled and file exists
    if (this.useFilesystemWatching) {
      try {
        // Check if file exists first
        try {
          await stat(this.transcriptPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // File doesn't exist yet - will watch for it with polling
            this.fallbackToPolling()
            return
          }
          throw error
        }

        this.watcher = watch(this.transcriptPath, () => {
          this.onFileChange()
        })

        this.watcher.on('error', (error) => {
          console.warn(`[ConversationTranscriptTailer] fs.watch failed for ${this.sessionId}, falling back to polling:`, error)
          this.fallbackToPolling()
        })
      } catch (error) {
        console.warn(`[ConversationTranscriptTailer] Could not start fs.watch for ${this.sessionId}, using polling:`, error)
        this.fallbackToPolling()
      }
    } else {
      // Polling requested explicitly
      this.fallbackToPolling()
    }
  }

  private async prepareInitialCheckpoint(): Promise<void> {
    try {
      const fileStats = await stat(this.transcriptPath)
      if (fileStats.size <= ConversationTranscriptTailer.MAX_INITIAL_REPLAY_BYTES) return

      // Start at a complete JSONL line. The first four megabytes are enough to
      // reconstruct current tool/file/model state without retaining old raw
      // events or replaying an unbounded transcript.
      const start = fileStats.size - ConversationTranscriptTailer.MAX_INITIAL_REPLAY_BYTES
      const fd = await open(this.transcriptPath, 'r')
      try {
        const buffer = Buffer.allocUnsafe(4096)
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, start)
        const newline = buffer.subarray(0, bytesRead).indexOf(10)
        this.checkpoint.byteOffset = newline >= 0 ? start + newline + 1 : start
      } finally {
        await fd.close()
      }
    } catch (error) {
      // A session can be created between discovery and transcript creation.
      // The normal tail path will retry from byte zero in that case.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[ConversationTranscriptTailer] Could not bound initial replay for ${this.sessionId}:`, error)
      }
    }
  }

  /**
   * Stop tailing and clean up
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
      this.debounceTimeout = null
    }

    this.removeAllListeners()
  }

  /**
   * Handle file change events from fs.watch()
   * Debounced to handle rapid sequential appends
   */
  private onFileChange(): void {
    // Debounce to batch rapid changes
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout)
    }

    this.debounceTimeout = setTimeout(() => {
      this.debounceTimeout = null
      this.tail()
    }, 50) // 50ms debounce for very rapid updates
  }

  /**
   * Fallback to polling when fs.watch is unavailable or unreliable
   */
  private fallbackToPolling(): void {
    if (this.pollInterval) return // Already polling

    // Conservative 1s polling interval
    this.pollInterval = setInterval(() => {
      this.tail()
    }, 1000)
  }

  /**
   * Read and parse new content from the transcript file
   */
  private async tail(): Promise<void> {
    // fs.watch can notify again while an earlier read is in flight. Serialize
    // tails so checkpoints never race backwards or duplicate activities.
    if (this.tailInProgress) {
      this.tailQueued = true
      return
    }
    this.tailInProgress = true

    try {
      // Check file size
      let fileStats
      try {
        fileStats = await stat(this.transcriptPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // File doesn't exist yet - normal for new sessions
          return
        }
        throw error
      }

      // No new data
      if (fileStats.size <= this.checkpoint.byteOffset) {
        return
      }

      // Read new data from checkpoint offset
      const newData = await this.readFrom(this.checkpoint.byteOffset, fileStats.size)
      if (!newData) return

      // Parse events from new data. Advance the byte checkpoint even when the
      // append only contains a partial JSON line; partialLine is retained and
      // completed by the next append, preventing duplicate re-reads.
      const events = this.parseEvents(newData)

      this.checkpoint.byteOffset = fileStats.size
      this.checkpoint.lastUpdated = Date.now()
      if (events.length > 0) {
        this.checkpoint.lastEventUuid = events[events.length - 1].uuid
        this.consecutiveParseErrors = 0

        // Emit each parsed event
        for (const event of events) {
          this.emit('transcript-event', event)
        }
      }
    } catch (error) {
      console.error(`[ConversationTranscriptTailer] Error tailing transcript for ${this.sessionId}:`, error)
    } finally {
      this.tailInProgress = false
      if (this.tailQueued) {
        this.tailQueued = false
        void this.tail()
      }
    }
  }

  /**
   * Read file content from a specific byte offset
   */
  private async readFrom(offset: number, fileSize: number): Promise<string | null> {
    const fd = await open(this.transcriptPath, 'r')
    try {
      const length = fileSize - offset
      if (length <= 0) return null

      const buffer = Buffer.allocUnsafe(length)
      await fd.read(buffer, 0, length, offset)
      return buffer.toString('utf8')
    } finally {
      await fd.close()
    }
  }

  /**
   * Parse JSONL events from raw data
   * Handles partial lines at the end (incomplete writes)
   */
  private parseEvents(data: string): TranscriptEvent[] {
    const lines = `${this.partialLine}${data}`.split('\n')
    const events: TranscriptEvent[] = []
    this.partialLine = lines.pop() ?? ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      try {
        const event = JSON.parse(line) as TranscriptEvent
        events.push(event)
        this.consecutiveParseErrors = 0
      } catch (parseError) {
        console.warn(`[ConversationTranscriptTailer] Parse error in transcript for ${this.sessionId}:`, parseError)
        this.consecutiveParseErrors++

        // A malformed complete line cannot become valid on a later append, so
        // keep going rather than replaying a whole transcript indefinitely.
        if (this.consecutiveParseErrors > 10) {
          console.error(`[ConversationTranscriptTailer] Too many parse errors for ${this.sessionId}; continuing after malformed lines`)
          this.consecutiveParseErrors = 0
        }
      }
    }

    return events
  }

  /**
   * Build the transcript file path from project path
   * Format: ~/.claude/projects/{encoded-path}/{sessionId}.jsonl
   */
  private buildTranscriptPath(projectPath: string): string {
    // Encode project path: /Users/name/project → -Users-name-project
    const encoded = projectPath
      .replace(/^\//, '-')
      .replace(/\//g, '-')

    return join(homedir(), '.claude', 'projects', encoded, `${this.sessionId}.jsonl`)
  }

  /**
   * Get current checkpoint (useful for debugging)
   */
  getCheckpoint(): TranscriptCheckpoint {
    return { ...this.checkpoint }
  }
}

/**
 * Extract useful information from transcript events
 */
export class TranscriptEventParser {
  /**
   * Extract the current task from a last-prompt event
   */
  static extractTask(event: LastPromptEvent): string | null {
    return event.lastPrompt || null
  }

  /**
   * Extract tool use information from assistant message
   */
  static extractToolUse(event: AssistantMessageEvent): Array<{
    id: string
    tool: string
    file?: string
    operation?: 'EDITING' | 'READING'
    command?: string
    question?: ObservedQuestionRequest
  }> {
    const toolUses: Array<{ id: string; tool: string; file?: string; operation?: 'EDITING' | 'READING'; command?: string; question?: ObservedQuestionRequest }> = []

    for (const rawBlock of event.message.content) {
      const block = this.asRecord(rawBlock)
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue

      const input = this.asRecord(block.input) || {}
      const tool = block.name
      let operation: 'EDITING' | 'READING' | undefined
      if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) operation = 'EDITING'
      else if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) operation = 'READING'

      toolUses.push({
        id: block.id,
        tool,
        file: this.extractFile(input),
        operation,
        command: typeof input.command === 'string' ? this.cleanCommand(input.command) : undefined,
        question: this.extractQuestion({ type: 'tool_use', id: block.id, name: tool, input } as ToolUseBlock)
      })
    }

    return toolUses
  }

  /** Claude's AskUserQuestion tool is an observed user-input boundary, not a normal tool call. */
  private static extractQuestion(tool: ToolUseBlock): ObservedQuestionRequest | undefined {
    if (tool.name !== 'AskUserQuestion') return undefined

    const rawQuestions = tool.input.questions
    if (!Array.isArray(rawQuestions)) return undefined

    const questions = rawQuestions.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const candidate = raw as Record<string, unknown>
      if (typeof candidate.question !== 'string') return []

      const options = Array.isArray(candidate.options)
        ? candidate.options.flatMap(option => {
            if (!option || typeof option !== 'object') return []
            const item = option as Record<string, unknown>
            if (typeof item.label !== 'string') return []
            return [{
              label: item.label,
              description: typeof item.description === 'string' ? item.description : undefined
            }]
          })
        : []

      const question: ObservedQuestion = {
        question: candidate.question,
        header: typeof candidate.header === 'string' ? candidate.header : undefined,
        options,
        multiSelect: candidate.multiSelect === true
      }
      return [question]
    })

    return questions.length > 0 ? { questions } : undefined
  }

  static extractAssistantText(event: AssistantMessageEvent): string | undefined {
    const text = event.message.content
      .map(block => this.asRecord(block))
      .filter((block): block is Record<string, unknown> => block?.type === 'text' && typeof block.text === 'string')
      .map(block => this.cleanAssistantText(block.text as string))
      .filter(Boolean)
      .join('\n')

    return this.truncate(text) || undefined
  }

  static hasThinking(event: AssistantMessageEvent): boolean {
    return event.message.content.some(block => this.asRecord(block)?.type === 'thinking')
  }

  static describeTool(tool: { tool: string; file?: string; command?: string }): string {
    const name = tool.tool.toLowerCase()
    if (tool.command) return `${name} · ${this.truncate(tool.command, 82)}`
    if (tool.file) return `${name} · ${tool.file.split('/').pop() || tool.file}`
    return name
  }

  static extractToolResults(event: UserMessageEvent): ToolResultBlock[] {
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    return content
      .map(block => this.asRecord(block))
      .filter((block): block is Record<string, unknown> => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
      .map(block => ({
        type: 'tool_result',
        tool_use_id: block.tool_use_id as string,
        content: typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content as { type: string; text?: string }[] : '',
        is_error: block.is_error === true
      }))
  }

  /**
   * Extract token count from token reminder attachment
   */
  static extractTokens(event: TokenReminderAttachment): { remaining: number } | null {
    // Parse: <total_tokens>14980100 tokens left</total_tokens>. This is a
    // remaining-context signal; Claude does not provide a trustworthy total in
    // this record, so callers must not invent one.
    const match = event.attachment.text.match(/<total_tokens>([\d,]+) tokens left<\/total_tokens>/i)
    if (!match) return null

    const remaining = parseInt(match[1].replace(/,/g, ''), 10)
    return Number.isFinite(remaining) ? { remaining } : null
  }

  static extractUserPrompt(event: UserMessageEvent): string | undefined {
    const content = event.message?.content
    if (typeof content === 'string') return this.cleanPrompt(content)
    if (!Array.isArray(content)) return undefined

    const text = content
      .map(block => this.asRecord(block))
      .filter((block): block is Record<string, unknown> => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
    return this.cleanPrompt(text)
  }

  static extractUsage(event: AssistantMessageEvent): import('./types').ObservedUsage | undefined {
    const usage = event.message.usage
    if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
    const thinkingTokens = usage.output_tokens_details?.thinking_tokens
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: this.optionalNumber(usage.cache_read_input_tokens),
      cacheCreationInputTokens: this.optionalNumber(usage.cache_creation_input_tokens),
      thinkingTokens: this.optionalNumber(thinkingTokens),
      totalTokens: usage.input_tokens + usage.output_tokens,
      turnCount: 1,
      lastInputTokens: usage.input_tokens,
      lastOutputTokens: usage.output_tokens
    }
  }

  static model(event: AssistantMessageEvent): string | undefined {
    return typeof event.message.model === 'string' ? event.message.model : undefined
  }

  static effort(event: AssistantMessageEvent): string | undefined {
    return typeof event.effort === 'string' ? event.effort : undefined
  }

  private static extractFile(input: Record<string, unknown>): string | undefined {
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof input[key] === 'string' && input[key]) return input[key] as string
    }
    return undefined
  }

  private static cleanCommand(command: string): string {
    return this.truncate(command.replace(/\s+/g, ' ').trim(), 96)
  }

  private static cleanAssistantText(text: string): string {
    return this.truncate(text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
  }

  private static cleanPrompt(text: string): string | undefined {
    const cleaned = text
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
      .replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ')
      .replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ')
      .replace(/<command-args>[\s\S]*?<\/command-args>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned || cleaned.startsWith('[Request interrupted') || cleaned.startsWith('<')) return undefined
    return this.truncate(cleaned, 360)
  }

  private static truncate(text: string, max = 240): string {
    if (text.length <= max) return text
    return `${text.slice(0, max - 1).trimEnd()}…`
  }

  private static optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  private static asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  }
}
