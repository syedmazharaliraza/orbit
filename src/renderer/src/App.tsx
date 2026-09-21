import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent } from 'react'
import { Astronaut, Helmet } from './Astronaut'
import { ActivityTicker } from './ActivityTicker'
import { collapsedSummary, crew, orbitSlots, orderedCrew, type Worker } from './crew'

type Mode = 'collapsed' | 'orbit' | 'preview' | 'empty'
type HookHealth = 'healthy' | 'degraded' | 'unknown'

export function App() {
  const [mode, setMode] = useState<Mode>('collapsed')
  const [closing, setClosing] = useState(false)
  const [navigationMessage, setNavigationMessage] = useState('')
  const [hookHealth, setHookHealth] = useState<HookHealth>('unknown')
  const opening = useRef(false)
  const [workers, setWorkers] = useState<Worker[]>(crew)
  const [selected, setSelected] = useState<Worker>(crew[0])
  const modeRef = useRef<Mode>(mode)
  const pendingMode = useRef<Mode | undefined>(undefined)
  const workersRef = useRef(workers)
  const previewTimer = useRef<number | undefined>(undefined)
  const collapseTimer = useRef<number | undefined>(undefined)
  const pointerRegion = useRef<'outside' | 'empty' | 'worker' | 'preview'>('outside')
  const request = useCallback((next: Mode) => {
    if (pendingMode.current === next || (!pendingMode.current && modeRef.current === next)) return
    pendingMode.current = next
    // BrowserWindow must resize before the renderer lays out a wider mode.
    // Rendering optimistically here briefly clips the preview to the old
    // window width, which is visible as a first-hover flash.
    void window.orbit.setMode(next)
  }, [])
  const clearTimer = (timer: MutableRefObject<number | undefined>) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
  }
  const cancelCollapse = useCallback(() => {
    clearTimer(collapseTimer)
    setClosing(false)
  }, [])
  const open = useCallback(() => {
    cancelCollapse()
    if (modeRef.current === 'collapsed') request(workersRef.current.length ? 'orbit' : 'empty')
  }, [cancelCollapse, request])
  const closePreview = useCallback(() => {
    clearTimer(previewTimer)
    if (modeRef.current === 'preview') request('orbit')
  }, [request])
  const closeOrbit = useCallback(() => {
    clearTimer(previewTimer)
    if (modeRef.current !== 'orbit' && modeRef.current !== 'preview' && modeRef.current !== 'empty') return
    if (collapseTimer.current !== undefined) return
    pointerRegion.current = 'outside'
    setClosing(true)
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = undefined
      request('collapsed')
      setClosing(false)
    }, 180)
  }, [request])
  const setPreview = useCallback((worker: Worker) => {
    clearTimer(previewTimer)
    cancelCollapse()
    pointerRegion.current = 'worker'
    setSelected(worker)
    if (modeRef.current === 'orbit') request('preview')
  }, [cancelCollapse, request])
  const schedulePreviewClose = useCallback(() => {
    clearTimer(previewTimer)
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = undefined
      if (pointerRegion.current === 'empty' || pointerRegion.current === 'outside') closePreview()
    }, 140)
  }, [closePreview])
  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-orbit-preview-region]') : null
    const region = target?.dataset.orbitPreviewRegion
    if (region?.startsWith('worker:')) {
      const worker = workersRef.current.find(item => item.id === region.slice('worker:'.length))
      if (worker) setPreview(worker)
      return
    }
    if (region === 'preview') {
      pointerRegion.current = 'preview'
      clearTimer(previewTimer)
      cancelCollapse()
      return
    }
    const previousRegion = pointerRegion.current
    pointerRegion.current = 'empty'
    // Start the grace period once at the boundary. Resetting it for every
    // mousemove would let a tooltip survive indefinitely while crossing blank
    // space, which was the source of the stuck-preview behaviour.
    if (previousRegion !== 'empty') schedulePreviewClose()
  }, [cancelCollapse, schedulePreviewClose, setPreview])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { workersRef.current = workers }, [workers])
  useEffect(() => window.orbit.onMode(next => {
    modeRef.current = next
    setMode(next)
    if (pendingMode.current === next) pendingMode.current = undefined
    if (next === 'collapsed') { clearTimer(collapseTimer); setClosing(false); pointerRegion.current = 'outside' }
  }), [])
  useEffect(() => window.orbit.onToggle(() => {
    if (modeRef.current === 'collapsed') open()
    else closeOrbit()
  }), [closeOrbit, open, request])
  useEffect(() => window.orbit.onPointerLeftWindow(closePreview), [closePreview])
  useEffect(() => {
    let mounted = true
    void window.orbit.getWorkers().then(updated => {
      if (!mounted) return
      setWorkers(updated); setSelected(current => updated.find(worker => worker.id === current.id) || updated[0] || current)
      if (!updated.length && modeRef.current !== 'collapsed' && modeRef.current !== 'empty') request('empty')
    })
    return () => { mounted = false }
  }, [request])
  useEffect(() => window.orbit.onWorkersUpdated(updated => {
    const selectedStillExists = updated.some(worker => worker.id === selected.id)
    setWorkers(updated); setSelected(current => updated.find(worker => worker.id === current.id) || updated[0] || current)
    if (!selectedStillExists) closePreview()
    if (!updated.length && modeRef.current !== 'collapsed' && modeRef.current !== 'empty') request('empty')
  }), [closePreview, request, selected.id])
  useEffect(() => window.orbit.onHookHealthChanged(health => setHookHealth(health)), [])
  useEffect(() => () => { clearTimer(previewTimer); clearTimer(collapseTimer) }, [])

  const openSession = async (worker: Worker) => {
    if (opening.current) return
    opening.current = true
    cancelCollapse()
    clearTimer(previewTimer)
    setNavigationMessage('')
    try {
      const result = await window.orbit.openSession(worker.id)
      if (result.ok) request('collapsed')
      else setNavigationMessage(result.message)
    } catch {
      setNavigationMessage('Could not open this Claude Code session.')
    } finally {
      opening.current = false
    }
  }

  return <main className={`app app--${mode}`} onPointerMove={onPointerMove}>
    <CrewPod workers={workers} onClick={open} visible={mode === 'collapsed'} />
    {(mode === 'orbit' || mode === 'preview') && <OrbitView workers={workers} selected={selected} preview={mode === 'preview'} closing={closing} onPreview={setPreview} onClose={closeOrbit} onOpen={openSession} navigationMessage={navigationMessage} hookHealth={hookHealth} />}
    {mode === 'empty' && <EmptyCrew closing={closing} onClose={closeOrbit} hookHealth={hookHealth} />}
  </main>
}

const dragThreshold = 16
type PodDrag = {
  phase: 'idle' | 'pressing' | 'dragging' | 'settling'
  pointerId: number
  startX: number
  startY: number
  moved: boolean
  anchorX: number
  anchorY: number
  posX: number
  posY: number
  velX: number
  velY: number
  targetX: number
  targetY: number
  stiffness: number
  damping: number
  instant: boolean
  lastFrame: number
  raf: number | undefined
}
function CrewPod({ workers, onClick, visible }: { workers: Worker[]; onClick: () => void; visible: boolean }) {
  const summary = collapsedSummary(workers)
  const label = summary.kind === 'empty' ? 'No observed Claude Code workers' : `Open ${workers.length} observed Claude Code sessions`
  const podRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<PodDrag>({ phase: 'idle', pointerId: -1, startX: 0, startY: 0, moved: false, anchorX: 0, anchorY: 0, posX: 0, posY: 0, velX: 0, velY: 0, targetX: 0, targetY: 0, stiffness: 1, damping: 1, instant: false, lastFrame: 0, raf: undefined })

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let timer: number | undefined
    const drift = () => {
      const angle = Math.random() * Math.PI * 2
      const distance = 1.5 + Math.random() * 2.5
      podRef.current?.style.setProperty('--pod-drift-x', `${Math.cos(angle) * distance}px`)
      podRef.current?.style.setProperty('--pod-drift-y', `${Math.sin(angle) * distance}px`)
      timer = window.setTimeout(drift, 1900 + Math.random() * 1200)
    }
    drift()
    return () => { if (timer !== undefined) window.clearTimeout(timer) }
  }, [])

  useEffect(() => () => {
    const drag = dragRef.current
    if (drag.raf !== undefined) window.cancelAnimationFrame(drag.raf)
    if (drag.phase === 'dragging' || drag.phase === 'settling') void window.orbit.dragEnd()
    drag.phase = 'idle'
  }, [])

  const step = (now: number) => {
    const drag = dragRef.current
    if (drag.phase !== 'dragging' && drag.phase !== 'settling') { drag.raf = undefined; return }
    const dt = Math.min((now - drag.lastFrame) / 1000, 1 / 32)
    drag.lastFrame = now
    if (drag.instant) {
      drag.posX = drag.targetX
      drag.posY = drag.targetY
      drag.velX = 0
      drag.velY = 0
    } else {
      drag.velX += (drag.stiffness * (drag.targetX - drag.posX) - drag.damping * drag.velX) * dt
      drag.velY += (drag.stiffness * (drag.targetY - drag.posY) - drag.damping * drag.velY) * dt
      drag.posX += drag.velX * dt
      drag.posY += drag.velY * dt
    }
    void window.orbit.dragMove({ x: Math.round(drag.posX), y: Math.round(drag.posY) })
    if (drag.phase === 'settling' && Math.abs(drag.targetX - drag.posX) < .5 && Math.abs(drag.targetY - drag.posY) < .5 && Math.abs(drag.velX) < .5 && Math.abs(drag.velY) < .5) {
      drag.raf = undefined
      drag.phase = 'idle'
      setDragging(false)
      void window.orbit.dragEnd()
      return
    }
    drag.raf = window.requestAnimationFrame(step)
  }

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (event.button !== 0 || drag.phase !== 'idle') return
    drag.phase = 'pressing'
    drag.pointerId = event.pointerId
    drag.startX = event.screenX
    drag.startY = event.screenY
    drag.moved = false
    podRef.current?.setPointerCapture(event.pointerId)
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag.phase === 'idle' || event.pointerId !== drag.pointerId) return
    if (drag.phase === 'pressing') {
      if ((event.screenX - drag.startX) ** 2 + (event.screenY - drag.startY) ** 2 < dragThreshold ** 2) return
      drag.phase = 'dragging'
      drag.moved = true
      setDragging(true)
      const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      drag.instant = instant
      drag.stiffness = instant ? 0 : 110
      drag.damping = instant ? 0 : 19
      void window.orbit.dragStart({ x: drag.startX, y: drag.startY }).then(bounds => {
        const current = dragRef.current
        if (current.phase !== 'dragging') return
        current.anchorX = drag.startX - bounds.x
        current.anchorY = drag.startY - bounds.y
        current.posX = bounds.x
        current.posY = bounds.y
        current.velX = 0
        current.velY = 0
        current.targetX = event.screenX - current.anchorX
        current.targetY = event.screenY - current.anchorY
        current.lastFrame = performance.now()
        current.raf = window.requestAnimationFrame(step)
      })
      return
    }
    if (drag.phase === 'dragging') {
      drag.targetX = event.screenX - drag.anchorX
      drag.targetY = event.screenY - drag.anchorY
    }
  }

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag.phase === 'idle' || event.pointerId !== drag.pointerId) return
    if (drag.phase === 'pressing') { drag.phase = 'idle'; return }
    drag.targetX = event.screenX - drag.anchorX
    drag.targetY = event.screenY - drag.anchorY
    drag.phase = 'settling'
  }

  const openPod = () => { if (dragRef.current.moved) return; onClick() }

  return <div
    ref={podRef}
    className={`crew-pod crew-pod--${summary.kind}${dragging ? ' crew-pod--dragging' : ''}${visible ? '' : ' crew-pod--hidden'}`}
    onPointerDown={visible ? begin : undefined}
    onPointerMove={visible ? move : undefined}
    onPointerUp={visible ? end : undefined}
    onPointerCancel={visible ? end : undefined}
    onClick={visible ? openPod : undefined}
    style={{ pointerEvents: visible ? 'auto' : 'none' }}
  >
    <div className="crew-pod__drag-ring" aria-label="Drag Orbit" title="Drag to move Orbit" />
    <button className="crew-pod__open" aria-label={label}><CrewOrbit workers={workers} /></button>
  </div>
}
const orbitDotSlots = [{ left: '48%', top: '-2px' }, { left: '82%', top: '17%' }, { left: '82%', top: '65%' }, { left: '48%', top: '87%' }, { left: '4%', top: '65%' }, { left: '4%', top: '17%' }]
function CrewOrbit({ workers }: { workers: Worker[] }) {
  const crew = orderedCrew(workers).slice(0, orbitDotSlots.length)
  if (!crew.length) return <span className="crew-orbit crew-orbit--empty" aria-hidden="true"><Helmet size={38} hue={210} mark="dot" state="idle" /></span>
  const captain = crew[0]
  const needsAttention = Boolean(captain.question || captain.permission || captain.state === 'waiting' || captain.signal)
  return <span className="crew-orbit" aria-hidden="true"><i className="crew-orbit__ring" />{crew.map((worker, index) => index === 0 && needsAttention ? null : <i key={worker.id} className="crew-orbit__dot" style={{ ...orbitDotSlots[index], background: `oklch(.72 .10 ${worker.hue})` }} />)}{needsAttention && <b className="crew-orbit__question">?</b>}<Helmet size={38} hue={captain.hue} mark={captain.mark} state={captain.state} delay={captain.delay} /></span>
}
function OrbitView({ workers: observed, selected, preview, closing, onPreview, onClose, onOpen, navigationMessage, hookHealth }: { workers: Worker[]; selected: Worker; preview: boolean; closing: boolean; onPreview: (worker: Worker) => void; onClose: () => void; onOpen: (worker: Worker) => void; navigationMessage: string; hookHealth: HookHealth }) {
  const workers = orderedCrew(observed)
  if (!workers.length) return null
  const attention = workers.filter(worker => worker.state === 'waiting' || worker.signal).length
  const healthMessage = hookHealth === 'degraded' ? '⚠️ Hook coverage degraded' : hookHealth === 'unknown' ? 'Initializing...' : navigationMessage || 'Observing Claude Code'
  return <div className={`orbit-stage${preview ? ' orbit-stage--preview' : ''}${closing ? ' orbit-stage--closing' : ''}`}>
    {preview && <HoverPreview key={selected.id} worker={selected} />}
    <div className="orbit-panel"><button className="orbit-close" onClick={onClose} aria-label="Close Orbit" title="Close Orbit">×</button><div className="orbit-ring orbit-ring--outer" /><div className={`orbit-ring orbit-ring--inner${attention ? ' orbit-ring--attention' : ''}`} /><div className={`orbit-hub${attention ? ' orbit-hub--attention' : ''}`}><b>{attention || workers.length}</b><span>{attention ? `${attention} NEEDS YOU` : `${workers.length} OBSERVED`}</span></div>{workers.slice(0, orbitSlots.length).map((worker, index) => { const slot = orbitSlots[index]; return <button key={worker.id} data-orbit-preview-region={`worker:${worker.id}`} className={`orbit-worker orbit-worker--${worker.state}${slot.inner ? ' orbit-worker--inner' : ''}${preview && selected.id !== worker.id ? ' orbit-worker--dim' : ''}`} style={{ left: slot.left, top: slot.top, '--delay': worker.delay } as CSSProperties} onFocus={() => onPreview(worker)} aria-label={`Open ${worker.title} in Claude Code`} aria-describedby={preview && selected.id === worker.id ? 'worker-preview' : undefined} onClick={() => onOpen(worker)}><span className={worker.signal ? 'worker-dashed' : ''}><Astronaut size={slot.size} hue={worker.hue} mark={worker.mark} state={worker.state} delay={worker.delay} /></span><strong>{worker.name}</strong><small>{worker.action}</small></button> })}</div>
    <div className="observation-bar orbit-drag-region" title="Drag to move Orbit"><span role="status">{healthMessage}</span></div>
  </div>
}
function HoverPreview({ worker }: { worker: Worker }) {
  const needsYou = worker.state === 'waiting'
  const asking = needsYou || worker.question || worker.permission
  const label = needsYou ? 'Needs you' : worker.permission ? 'Permission requested' : worker.question ? 'Question' : ({ working: 'Working', waiting: 'Needs you', attention: 'Check in', done: 'Completed', idle: 'Idle' })[worker.presentation]
  const tone = asking ? 'waiting' : worker.presentation
  return <aside id="worker-preview" role="tooltip" data-orbit-preview-region="preview" className={`hover-preview hover-preview--${tone}`}>
    <span className="preview-state"><i aria-hidden="true" />{label}</span>
    <b className="hover-title">{worker.title}</b>
    <ActivityTicker text={worker.action} expanded={Boolean(asking || worker.state === 'done')} />
    {worker.context && <div className={`preview-context${worker.context.choices ? ' preview-context--choices' : worker.context.code ? ' preview-context--code' : ''}`}>
      <span>{worker.context.label}</span>
      {worker.context.choices ? <>
        <ol className="preview-choices" aria-label="Available choices in Claude Code">
          {worker.context.choices.map((choice, index) => <li key={`${index}-${choice}`}>
            <span className="preview-choice-number" aria-hidden="true">{index + 1}</span>
            <span className="preview-choice-label">{choice}</span>
          </li>)}
        </ol>
        {worker.context.remaining > 0 && <small className="preview-choices-more">+{worker.context.remaining} more in Claude Code</small>}
      </> : <p>{worker.context.text}</p>}
    </div>}
    <i className="hover-arrow" aria-hidden="true" />
  </aside>
}
function EmptyCrew({ closing, onClose, hookHealth }: { closing: boolean; onClose: () => void; hookHealth: HookHealth }) {
  const healthMessage = hookHealth === 'degraded' ? '⚠️ Hook coverage degraded' : hookHealth === 'unknown' ? 'Initializing...' : 'Observing local Claude Code sessions'
  return <div className={`empty-stage${closing ? ' empty-stage--closing' : ''}`}><section className="empty-crew"><button className="orbit-close" onClick={onClose} aria-label="Close Orbit">×</button><div className="empty-airlock"><i /><Astronaut size={52} hue={210} mark="dot" state="idle" /></div><div><h1>Nobody out there yet</h1><p>Orbit is observing local Claude Code sessions. Start a session in your terminal and it will appear here.</p></div><small>read-only observation</small><small>drag me anywhere</small></section><div className="observation-bar orbit-drag-region" title="Drag to move Orbit"><span>{healthMessage}</span><em>read-only</em></div></div>
}
