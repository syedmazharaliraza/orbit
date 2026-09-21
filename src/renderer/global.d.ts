import type { Worker } from './src/crew'

export {}

declare global {
  interface Window {
    orbit: {
      getWorkers(): Promise<Worker[]>
      openSession(sessionId: string): Promise<{ ok: boolean; mode?: 'application' | 'terminal'; message: string }>
      setMode(mode: 'collapsed' | 'orbit' | 'preview' | 'empty'): Promise<void>
      dragStart(position: { x: number; y: number }): Promise<{ x: number; y: number }>
      dragMove(position: { x: number; y: number }): Promise<void>
      dragEnd(): Promise<void>
      onMode(listener: (mode: 'collapsed' | 'orbit' | 'preview' | 'empty') => void): () => void
      onToggle(listener: () => void): () => void
      onPointerLeftWindow(listener: () => void): () => void
      onWorkersUpdated(listener: (workers: Worker[]) => void): () => void
      onHookHealthChanged(listener: (health: 'healthy' | 'degraded' | 'unknown') => void): () => void
    }
  }
}
