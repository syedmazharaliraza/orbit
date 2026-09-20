import { EventEmitter } from 'events'
import * as http from 'http'

export interface HookEvent {
  eventType: string
  sessionId: string
  payload: Record<string, unknown>
}

export class OrbitHookServer extends EventEmitter {
  private server: http.Server | null = null
  private port: number | null = null
  private activeConnections: Set<http.ServerResponse> = new Set()

  async start(): Promise<number> {
    if (this.server) {
      throw new Error('Server already started')
    }

    const PORT_START = 19400
    const PORT_END = 19499

    for (let port = PORT_START; port <= PORT_END; port++) {
      try {
        await this.tryBindPort(port)
        this.port = port
        console.log(`[OrbitHookServer] Listening on http://localhost:${port}/hooks`)
        return port
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr.code !== 'EADDRINUSE' || port === PORT_END) {
          throw new Error(
            `Failed to bind to any port in range ${PORT_START}-${PORT_END}: ${nodeErr.message}`
          )
        }
        // Try next port
      }
    }

    throw new Error('Unreachable: port loop should have thrown')
  }

  private tryBindPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })

      server.listen(port, 'localhost', () => {
        this.server = server
        resolve()
      })
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Track active connections for graceful shutdown
    this.activeConnections.add(res)
    res.on('close', () => {
      this.activeConnections.delete(res)
    })

    // Only accept POST to /hooks
    if (req.method !== 'POST' || req.url !== '/hooks') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        const payload = JSON.parse(body) as Record<string, unknown>

        // Extract session_id and event type from payload
        const sessionId = payload.session_id as string | undefined
        const eventType = this.extractEventType(payload)

        if (!sessionId) {
          console.warn('[OrbitHookServer] Hook event missing session_id:', eventType)
        }

        // Emit hook event
        this.emit('hook-event', {
          eventType,
          sessionId: sessionId || 'unknown',
          payload
        } as HookEvent)

        // Return 200 immediately (ORBIT is observe-only, never blocks Claude Code)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      } catch (err) {
        console.error('[OrbitHookServer] Error parsing hook event:', err)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })

    req.on('error', (err) => {
      console.error('[OrbitHookServer] Request error:', err)
    })
  }

  private extractEventType(payload: Record<string, unknown>): string {
    // Claude Code hook payloads typically include the hook name in one of these fields
    // Priority order: hook > event > eventType > inferred from structure
    if (typeof payload.hook === 'string') return payload.hook
    if (typeof payload.event === 'string') return payload.event
    if (typeof payload.eventType === 'string') return payload.eventType
    if (typeof payload.type === 'string') return payload.type

    // Infer from tool presence (fallback for older hook formats)
    if (payload.tool_name && payload.tool_response) return 'PostToolUse'
    if (payload.tool_name && payload.tool_input) return 'PreToolUse'

    return 'Unknown'
  }

  stop(): void {
    if (!this.server) {
      return
    }

    console.log('[OrbitHookServer] Stopping server...')

    // Destroy all active connections
    for (const res of this.activeConnections) {
      res.destroy()
    }
    this.activeConnections.clear()

    // Close server
    this.server.close(() => {
      console.log('[OrbitHookServer] Server closed')
    })

    this.server = null
    this.port = null
  }

  getPort(): number | null {
    return this.port
  }
}
