import { contextBridge, ipcRenderer } from 'electron'

type Mode = 'collapsed' | 'orbit' | 'preview' | 'empty'

contextBridge.exposeInMainWorld('orbit', {
  getWorkers: () => ipcRenderer.invoke('orbit:get-workers'),
  openSession: (sessionId: string) => ipcRenderer.invoke('orbit:open-session', sessionId),
  setMode: (mode: Mode) => ipcRenderer.invoke('orbit:set-mode', mode),
  dragStart: (position: { x: number; y: number }) => ipcRenderer.invoke('orbit:drag-start', position),
  dragMove: (position: { x: number; y: number }) => ipcRenderer.invoke('orbit:drag-move', position),
  dragEnd: () => ipcRenderer.invoke('orbit:drag-end'),
  onMode: (listener: (mode: Mode) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: Mode) => listener(mode)
    ipcRenderer.on('orbit:mode', handler)
    return () => ipcRenderer.removeListener('orbit:mode', handler)
  },
  onToggle: (listener: () => void) => {
    ipcRenderer.on('orbit:toggle', listener)
    return () => ipcRenderer.removeListener('orbit:toggle', listener)
  },
  onPointerLeftWindow: (listener: () => void) => {
    ipcRenderer.on('orbit:pointer-left-window', listener)
    return () => ipcRenderer.removeListener('orbit:pointer-left-window', listener)
  },
  onWorkersUpdated: (listener: (workers: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, workers: unknown[]) => listener(workers)
    ipcRenderer.on('orbit:workers-updated', handler)
    return () => ipcRenderer.removeListener('orbit:workers-updated', handler)
  }
})
