import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent } from 'react'
import { Astronaut, Helmet } from './Astronaut'
import { collapsedSummary, crew, orbitSlots, orderedCrew, type Worker } from './crew'

type Mode = 'collapsed' | 'orbit' | 'preview' | 'detail' | 'empty'
export function App() {
  const [mode, setMode] = useState<Mode>('collapsed')
  const [closing, setClosing] = useState(false)
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
    else if (modeRef.current === 'detail') request('orbit')
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
  useEffect(() => () => { clearTimer(previewTimer); clearTimer(collapseTimer) }, [])

  return <main className={`app app--${mode}`} onPointerMove={onPointerMove}>
    <CrewPod workers={workers} onClick={open} visible={mode === 'collapsed'} />
    {(mode === 'orbit' || mode === 'preview') && <OrbitView workers={workers} selected={selected} preview={mode === 'preview'} closing={closing} onPreview={setPreview} onClose={closeOrbit} onDetail={worker => { cancelCollapse(); setSelected(worker); request('detail') }} />}
    {mode === 'detail' && <WorkerDetail worker={selected} onClose={() => request('orbit')} />}
    {mode === 'empty' && <EmptyCrew closing={closing} onClose={closeOrbit} />}
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
function PodCopy({ title, detail, extra }: { title: string; detail: string; extra?: string }) {
  return <span className="pod-copy"><b>{title}</b><em>{detail}{extra ? ` · ${extra}` : ''}</em></span>
}
function OrbitView({ workers: observed, selected, preview, closing, onPreview, onClose, onDetail }: { workers: Worker[]; selected: Worker; preview: boolean; closing: boolean; onPreview: (worker: Worker) => void; onClose: () => void; onDetail: (worker: Worker) => void }) {
  const workers = orderedCrew(observed)
  if (!workers.length) return null
  const attention = workers.filter(worker => worker.state === 'waiting' || worker.signal).length
  return <div className={`orbit-stage${preview ? ' orbit-stage--preview' : ''}${closing ? ' orbit-stage--closing' : ''}`}>
    {preview && <HoverPreview worker={selected} />}
    <div className="orbit-panel"><button className="orbit-close" onClick={onClose} aria-label="Close Orbit" title="Close Orbit">×</button><div className="orbit-ring orbit-ring--outer" /><div className={`orbit-ring orbit-ring--inner${attention ? ' orbit-ring--attention' : ''}`} /><div className={`orbit-hub${attention ? ' orbit-hub--attention' : ''}`}><b>{attention || workers.length}</b><span>{attention ? `${attention} NEEDS YOU` : `${workers.length} OBSERVED`}</span></div>{workers.slice(0, orbitSlots.length).map((worker, index) => { const slot = orbitSlots[index]; return <button key={worker.id} data-orbit-preview-region={`worker:${worker.id}`} className={`orbit-worker orbit-worker--${worker.state}${slot.inner ? ' orbit-worker--inner' : ''}${preview && selected.id !== worker.id ? ' orbit-worker--dim' : ''}`} style={{ left: slot.left, top: slot.top, '--delay': worker.delay } as CSSProperties} onFocus={() => onPreview(worker)} onClick={() => onDetail(worker)}><span className={worker.signal ? 'worker-dashed' : ''}><Astronaut size={slot.size} hue={worker.hue} mark={worker.mark} state={worker.state} delay={worker.delay} /></span><strong>{worker.name}</strong><small>{worker.question ? 'needs your answer' : worker.permission ? 'permission requested' : worker.signal ? `possible ${worker.signal.kind}` : worker.action}</small></button> })}</div>
    <div className="composer composer--observing orbit-drag-region" title="Drag to move Orbit"><span>Observing local Claude Code sessions</span><em>read-only</em></div>
  </div>
}
function HoverPreview({ worker }: { worker: Worker }) {
  const attention = worker.question?.questions[0]?.question || worker.permission?.question
  return <aside data-orbit-preview-region="preview" className={`hover-preview hover-preview--${worker.state}`}><div><b>{worker.name}</b><em className={`state-label state-label--${worker.presentation}`}>{presentationLabel(worker.presentation)} · {worker.elapsed}</em></div><p>{attention || worker.task}</p><code><i>›</i> {worker.question ? 'waiting for your answer in Claude Code' : worker.permission ? 'waiting for permission in Claude Code' : worker.tool}</code><div className="hover-file"><span className={worker.fileTag === 'EDITING' ? 'tag tag--edit' : 'tag'}>{worker.fileTag}</span><b>{worker.file || 'no current file'}</b><small>{worker.path}</small></div><code>{worker.repo}{worker.branch ? ` · ${worker.branch}` : ''}<br />{worker.model} · {worker.effort} · {worker.context}</code><i className="hover-arrow" /></aside>
}
function WorkerDetail({ worker, onClose }: { worker: Worker; onClose: () => void }) {
  const attention = worker.question || worker.permission
  const [opening, setOpening] = useState(false)
  const [openMessage, setOpenMessage] = useState('')
  const openSession = async () => {
    setOpening(true)
    setOpenMessage('')
    try {
      const result = await window.orbit.openSession(worker.id)
      setOpenMessage(result.message)
    } catch (error) {
      setOpenMessage(error instanceof Error ? error.message : 'Orbit could not open this session.')
    } finally {
      setOpening(false)
    }
  }
  return <section className={`worker-detail worker-detail--${worker.state}`}>
    <header className="detail-header"><div className={`detail-avatar detail-avatar--${worker.state}`}><Astronaut size={56} hue={worker.hue} mark={worker.mark} state={worker.state} /></div><div><div className="detail-title"><h1>{worker.name}</h1><span className={`detail-status detail-status--${worker.presentation}`}>{presentationLabel(worker.presentation)} · {worker.elapsed}</span></div><p>{worker.task}</p></div><button className="detail-close" onClick={onClose} aria-label="Back to orbit">×</button></header>
    <div className="detail-chips"><span>{worker.repo || 'repository unavailable'}</span>{worker.branch && <span>{worker.branch}</span>}<span>{worker.model}</span><span>effort {worker.effort}</span><span>{worker.priority}</span></div>
    <section className="detail-current"><div><span className={worker.fileTag === 'EDITING' ? 'tag tag--edit' : 'tag'}>{worker.file ? worker.fileTag : 'ACTIVITY'}</span><b>{worker.file || worker.action || 'No current activity observed'}</b><small>{worker.path}</small><em>{worker.edit}</em></div>{worker.tools?.length ? <div className="observed-row"><label>TOOLS</label>{worker.tools.map(tool => <span key={tool.name}>{tool.name.toLowerCase()} ×{tool.count}</span>)}</div> : null}{worker.relevantFiles?.length ? <div className="observed-row"><label>FILES</label>{worker.relevantFiles.slice(0, 6).map(file => <span key={file}>{file.split('/').pop() || file}</span>)}</div> : null}</section>
    {worker.question && <QuestionNotice question={worker.question} />}{worker.permission && <PermissionNotice permission={worker.permission} />}{worker.waitingFor && <div className="waiting-note">{waitingLabel(worker.waitingFor)}</div>}
    <section className="detail-log"><div><label>ACTIVITY · {worker.activity.length}</label><code>{worker.activity.map((item, index) => <span key={`${item.observedAt || item.time}-${index}`} className={item.current ? 'activity-current green' : ''}>{item.current ? '› ' : ''}{item.time} {item.text}</span>)}</code></div><div><label>LAST MEANINGFUL OUTPUT</label><p>{worker.message ? `“${worker.message}”` : 'No meaningful assistant output observed yet.'}</p>{worker.usage && <small className="usage-copy">{formatUsage(worker.usage)}</small>}</div></section>
    <div className="detail-budget"><span>{worker.elapsed}</span>{worker.budget !== undefined && <div><i style={{ width: `${worker.budget}%` }} /></div>}<span>{worker.context}</span>{worker.cost && <b>{worker.cost}</b>}</div>
    {worker.signal ? <DriftHint worker={worker} /> : <div className="detail-signal"><i />observation-only · no Claude input is sent</div>}
    <footer><span>{openMessage || (attention ? 'Return to Claude Code to respond.' : 'Observed session · read-only')}</span><button className="open-session" disabled={!worker.canOpenSession || opening} onClick={() => void openSession()}>{opening ? 'Opening…' : 'Open session'}</button></footer>
  </section>
}
function QuestionNotice({ question }: { question: NonNullable<Worker['question']> }) { return <section className="question-request"><b>CLAUDE NEEDS YOUR INPUT</b>{question.questions.map((item, index) => <div className="question-block" key={`${item.header || 'question'}-${index}`}>{item.header && <label>{item.header}</label>}<p>{item.question}</p><div className="question-options">{item.options.map(option => <span className="question-option" key={option.label}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>)}</div></div>)}<em>Return to the Claude Code session to answer.</em></section> }
function PermissionNotice({ permission }: { permission: NonNullable<Worker['permission']> }) { const [before, after] = permission.question.split('{command}'); return <section className="permission"><b>CLAUDE IS WAITING FOR PERMISSION</b><p>{before}<code>{permission.command}</code>{after}</p><small>Return to the Claude Code session to decide.</small></section> }
function DriftHint({ worker }: { worker: Worker }) { const signal = worker.signal!; return <section className={`heuristic heuristic--${signal.kind}`}><div><i />POSSIBLY {signal.kind.toUpperCase()} · {signal.confidence}% · A GUESS</div><p>{signal.evidence}</p>{signal.rule && <small>rule: {signal.rule}</small>}{signal.files && <div className="heuristic-files">{signal.files.map(file => <span className={file.related ? 'related' : ''} key={file.name}>{file.name}</span>)}</div>}<small>Informational only; Orbit does not alter this session.</small></section> }
function EmptyCrew({ closing, onClose }: { closing: boolean; onClose: () => void }) { return <div className={`empty-stage${closing ? ' empty-stage--closing' : ''}`}><section className="empty-crew"><button className="orbit-close" onClick={onClose} aria-label="Close Orbit">×</button><div className="empty-airlock"><i /><Astronaut size={52} hue={210} mark="dot" state="idle" /></div><div><h1>Nobody out there yet</h1><p>Orbit is observing local Claude Code sessions. Start a session in your terminal and it will appear here.</p></div><small>read-only observation</small><small>drag me anywhere</small></section><div className="composer composer--observing orbit-drag-region" title="Drag to move Orbit"><span>Observing local Claude Code sessions</span><em>read-only</em></div></div> }
function formatUsage(usage: NonNullable<Worker['usage']>) { const format = (tokens: number) => tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`; const cache = usage.cacheReadInputTokens ? ` · ${format(usage.cacheReadInputTokens)} cached` : ''; return `${format(usage.inputTokens)} in · ${format(usage.outputTokens)} out${cache} · ${usage.turnCount} turn${usage.turnCount === 1 ? '' : 's'}` }
function waitingLabel(reason: string) { if (/permission|approval|approve|allow/i.test(reason)) return 'waiting for permission in Claude Code'; if (/question|input|choice/i.test(reason)) return 'waiting for your input in Claude Code'; return 'Claude Code has paused for input' }
function presentationLabel(state: Worker['presentation']) { return ({ working: 'WORKING', waiting: 'NEEDS YOU', attention: 'NEEDS CHECK', done: 'FINISHED', idle: 'IDLE' })[state] }
