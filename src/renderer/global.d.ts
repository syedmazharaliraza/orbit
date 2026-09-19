import type { Worker } from './src/crew'

export {}

declare global {
  interface Window {
    orbit: {
      getWorkers(): Promise<Worker[]>
      setMode(mode: 'collapsed' | 'orbit' | 'preview' | 'detail' | 'empty'): Promise<void>
      onMode(listener: (mode: 'collapsed' | 'orbit' | 'preview' | 'detail' | 'empty') => void): () => void
      onToggle(listener: () => void): () => void
      onPointerLeftWindow(listener: () => void): () => void
      onWorkersUpdated(listener: (workers: Worker[]) => void): () => void
    }
  }
}
