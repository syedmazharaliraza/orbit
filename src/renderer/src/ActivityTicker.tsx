import { useEffect, useState } from 'react'

/** Finish each motion, coalescing bursts to the latest status without a history queue. */
export function ActivityTicker({ text, expanded = false }: { text: string; expanded?: boolean }) {
  const [frame, setFrame] = useState<{ current: string; previous?: string; revision: number }>({ current: text, revision: 0 })
  useEffect(() => {
    if (frame.previous !== undefined || frame.current === text) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setFrame({ current: text, previous: reduceMotion ? undefined : frame.current, revision: frame.revision + 1 })
  }, [text, frame])
  useEffect(() => {
    if (frame.previous === undefined) return
    const timer = window.setTimeout(() => setFrame(current => ({ ...current, previous: undefined })), 380)
    return () => window.clearTimeout(timer)
  }, [frame])

  return <div className={`activity-ticker${expanded ? ' activity-ticker--expanded' : ''}`}>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{text}</span>
    {frame.previous !== undefined && <span key={`previous-${frame.revision}`} aria-hidden="true" className="activity-ticker__line activity-ticker__line--leave">{frame.previous}</span>}
    <span key={frame.revision} aria-hidden="true" className={`activity-ticker__line${frame.previous !== undefined ? ' activity-ticker__line--enter' : ''}`}>{frame.current}</span>
  </div>
}
