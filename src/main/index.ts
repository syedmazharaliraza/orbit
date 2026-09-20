import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { WorkerManager } from './claude/WorkerManager'
import { PersistenceStore } from './runtime/PersistenceStore'
import { crew } from '../renderer/src/crew'

type Mode = 'collapsed' | 'orbit' | 'preview' | 'detail' | 'empty'
// The collapsed pod keeps one fixed footprint across worker transitions so
// transcript updates never move the desktop window under the pointer.
const pod = { width: 128, height: 128 }
const orbit = { width: 330, height: 388 }
const preview = { width: 566, height: 388 }
const detail = { width: 408, height: 704 }
const empty = { width: 330, height: 388 }

let window: BrowserWindow | undefined
let mode: Mode = 'collapsed'
let workerManager: WorkerManager | undefined
let persistence: PersistenceStore | undefined
let pointerMonitor: NodeJS.Timeout | undefined
let collapsedAnchor: { x: number; y: number } | undefined
let programmaticBounds: Electron.Rectangle | undefined
let dragging = false
const mockAttentionWorkers = () => process.env.ORBIT_MOCK_ATTENTION === '1' ? [crew[0]] : undefined

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), Math.max(min, max)) }
function currentWorkArea() {
  if (!window) return screen.getPrimaryDisplay().workArea
  const bounds = window.getBounds()
  return screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }).workArea
}
function initialBounds() {
  const saved = persistence?.snapshot().position
  const area = saved
    ? screen.getDisplayNearestPoint({ x: saved.x + pod.width / 2, y: saved.y + pod.height / 2 }).workArea
    : screen.getPrimaryDisplay().workArea
  const bounds = {
    x: saved ? clamp(saved.x, area.x, area.x + area.width - pod.width) : area.x + area.width - pod.width - 22,
    y: saved ? clamp(saved.y, area.y, area.y + area.height - pod.height) : area.y + area.height - pod.height - 22,
    ...pod
  }
  collapsedAnchor = { x: bounds.x, y: bounds.y }
  return bounds
}
function updateCollapsedAnchor(bounds: Electron.Rectangle): void {
  const area = currentWorkArea()
  collapsedAnchor = {
    x: clamp(bounds.x + bounds.width - pod.width, area.x, area.x + area.width - pod.width),
    y: clamp(bounds.y + bounds.height - pod.height, area.y, area.y + area.height - pod.height)
  }
}
function snapToWorkArea(): void {
  if (!window) return
  const bounds = window.getBounds(); const area = currentWorkArea(); const threshold = 18
  const right = area.x + area.width - bounds.width; const bottom = area.y + area.height - bounds.height
  const x = clamp(Math.abs(bounds.x - area.x) <= threshold ? area.x : Math.abs(bounds.x - right) <= threshold ? right : bounds.x, area.x, right)
  const y = clamp(Math.abs(bounds.y - area.y) <= threshold ? area.y : Math.abs(bounds.y - bottom) <= threshold ? bottom : bounds.y, area.y, bottom)
  if (x !== bounds.x || y !== bounds.y) window.setPosition(x, y, false)
}
function persistPosition(): void {
  if (!window) return
  if (collapsedAnchor) void persistence?.update({ position: collapsedAnchor })
}
function startPointerMonitor(): void {
  if (pointerMonitor) clearInterval(pointerMonitor)
  let wasInside = false
  pointerMonitor = setInterval(() => {
    if (!window || window.isDestroyed() || !window.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = window.getBounds()
    const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height
    if (wasInside && !inside) window.webContents.send('orbit:pointer-left-window')
    wasInside = inside
  }, 40)
}
function setMode(nextMode: Mode): void {
  if (!window || mode === nextMode) return
  const nextSize = ({ collapsed: pod, orbit, preview, detail, empty } as const)[nextMode]
  const area = currentWorkArea()
  const current = window.getBounds()
  const anchor = collapsedAnchor || {
    x: current.x + current.width - pod.width,
    y: current.y + current.height - pod.height
  }
  // Expansion may be clipped at a display edge, but that must not mutate the
  // pod's intended desktop location. Collapse always returns to this anchor.
  const nextBounds = {
    x: clamp(anchor.x + pod.width - nextSize.width, area.x, area.x + area.width - nextSize.width),
    y: clamp(anchor.y + pod.height - nextSize.height, area.y, area.y + area.height - nextSize.height),
    ...nextSize
  }
  programmaticBounds = nextBounds
  window.setBounds(nextBounds, false)
  mode = nextMode
  window.webContents.send('orbit:mode', mode)
}
function createWindow(): void {
  window = new BrowserWindow({
    ...initialBounds(), frame: false, transparent: true, hasShadow: false, resizable: false, movable: true, focusable: false, skipTaskbar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }, show: false
  })
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  window.setMenuBarVisibility(false)
  window.on('closed', () => { window = undefined })
  window.on('moved', () => {
    if (!dragging) snapToWorkArea()
    const bounds = window!.getBounds()
    const isProgrammaticMove = programmaticBounds && bounds.x === programmaticBounds.x && bounds.y === programmaticBounds.y && bounds.width === programmaticBounds.width && bounds.height === programmaticBounds.height
    if (isProgrammaticMove) programmaticBounds = undefined
    else { updateCollapsedAnchor(bounds); if (!dragging) persistPosition() }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.once('ready-to-show', async () => {
    window?.showInactive()
    startPointerMonitor()
    if (window && !mockAttentionWorkers()) {
      workerManager = new WorkerManager()
      await workerManager.initialize(window)
      workerManager.on('integration-error', (error: Error) => console.error('[Orbit observation]', error))
    }
    if (process.env.ORBIT_FIXTURE === 'empty') setMode('empty')
    else if (process.env.ORBIT_START_MODE === 'expanded' || process.env.ORBIT_START_MODE === 'orbit') setMode('orbit')
    else if (process.env.ORBIT_START_MODE === 'preview') setMode('preview')
    else if (process.env.ORBIT_START_MODE === 'detail') setMode('detail')
    if (process.env.ORBIT_CAPTURE) setTimeout(async () => {
      const image = await window?.webContents.capturePage()
      if (image) await writeFile(process.env.ORBIT_CAPTURE!, image.toPNG())
    }, Number(process.env.ORBIT_CAPTURE_DELAY || 900))
  })
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  persistence = new PersistenceStore(join(app.getPath('userData'), 'orbit-state.json'))
  await persistence.load()
  createWindow()
  const modeSchema = z.enum(['collapsed', 'orbit', 'preview', 'detail', 'empty'])
  const pointSchema = z.object({ x: z.number(), y: z.number() })
  ipcMain.handle('orbit:set-mode', (_event, value: unknown) => setMode(modeSchema.parse(value)))
  ipcMain.handle('orbit:get-workers', () => mockAttentionWorkers() || workerManager?.getWorkerSnapshot() || [])
  ipcMain.handle('orbit:drag-start', (_event, value: unknown) => {
    if (!window || window.isDestroyed() || dragging || mode !== 'collapsed') return { x: 0, y: 0 }
    pointSchema.parse(value)
    dragging = true
    return { x: window.getBounds().x, y: window.getBounds().y }
  })
  ipcMain.handle('orbit:drag-move', (_event, value: unknown) => {
    if (!window || window.isDestroyed() || !dragging) return
    const point = pointSchema.parse(value)
    // The spring simulation in the renderer asks for absolute positions; keep at
    // least a sliver of the pod reachable so a fast flick can't strand it.
    const bounds = window.getBounds()
    const area = currentWorkArea()
    const visible = 44
    window.setPosition(
      clamp(Math.round(point.x), area.x - bounds.width + visible, area.x + area.width - visible),
      clamp(Math.round(point.y), area.y - bounds.height + visible, area.y + area.height - visible),
      false
    )
  })
  ipcMain.handle('orbit:drag-end', () => {
    if (!dragging) return
    dragging = false
    if (!window || window.isDestroyed()) return
    snapToWorkArea()
    updateCollapsedAnchor(window.getBounds())
    persistPosition()
  })
  globalShortcut.register('Control+Alt+O', () => window?.webContents.send('orbit:toggle'))
})
app.on('will-quit', () => { globalShortcut.unregisterAll(); workerManager?.stop() })
app.on('will-quit', () => { if (pointerMonitor) clearInterval(pointerMonitor) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
