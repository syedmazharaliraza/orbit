import type { CSSProperties } from 'react'
import type { Mark, WorkerState } from './crew'

type Props = { size: number; hue: number; mark: Mark; state?: WorkerState; delay?: string; compact?: boolean }

type HelmetProps = Omit<Props, 'compact'>

/** The collapsed surface uses helmets only: at this scale they stay legible where a full suit does not. */
export function Helmet({ size, hue, mark, state = 'working', delay = '0s' }: HelmetProps) {
  const unit = (value: number) => `${value}px`
  const eye = Math.max(1.4, size * .075)
  const markSize = size * .11
  const markWidth = { bar: 2.2, dot: 1, two: 2.4, ring: 1.7, diamond: 1.4, square: 1.5 }[mark] * markSize
  const suit = `oklch(.985 .010 ${hue})`
  const shade = `oklch(.905 .035 ${hue})`
  const ink = `oklch(.34 .045 ${hue})`
  const markInk = `oklch(.62 .10 ${hue})`
  const confused = state === 'waiting'
  const stateColor = { working: 'oklch(.72 .14 155)', waiting: 'oklch(.78 .15 75)', stuck: 'oklch(.64 .19 25)', drift: 'oklch(.66 .16 305)', done: 'oklch(.70 .10 240)', idle: 'oklch(.78 .01 265)' }[state]
  const markStyle: CSSProperties = {
    width: unit(markWidth), height: unit(mark === 'ring' ? markSize * 1.7 : mark === 'diamond' || mark === 'square' ? markSize * 1.4 : mark === 'dot' ? markSize : markSize * .7),
    marginLeft: unit(-markWidth / 2), background: mark === 'ring' ? 'transparent' : markInk,
    border: mark === 'ring' ? `${Math.max(1, markSize * .42)}px solid ${markInk}` : undefined,
    borderRadius: mark === 'diamond' ? unit(markSize * .25) : '999px',
    boxShadow: mark === 'two' ? `0 ${unit(markSize * 1.2)} 0 ${markInk}` : undefined,
    transform: mark === 'diamond' ? 'rotate(45deg)' : undefined
  }
  const rootStyle = { '--helmet-size': unit(size), '--state-color': stateColor, animationDelay: delay } as CSSProperties

  return <span className={`helmet helmet--${state}`} style={rootStyle}>
    <span className="helmet__shell" style={{ background: suit, boxShadow: `inset -${unit(Math.max(1, size * .035))} -${unit(Math.max(1, size * .035))} 0 ${shade}, 0 ${unit(Math.max(1, size * .035))} ${unit(size * .12)} oklch(.55 .04 265 / .16)` }}>
      <span className="helmet__visor" style={{ width: unit(size * .70), height: unit(size * .48), left: unit(size * .15), top: unit(size * .25), borderRadius: unit(size * .24), background: `linear-gradient(155deg, oklch(.94 .045 ${hue}), oklch(.80 .095 ${hue}))` }}>
        {confused && <><i className="helmet__brow" style={{ width: unit(eye * 1.7), height: unit(Math.max(1, eye * .22)), left: unit(size * .18), top: unit(size * .07), background: ink, transform: 'rotate(-18deg)' }} /><i className="helmet__brow" style={{ width: unit(eye * 1.7), height: unit(Math.max(1, eye * .22)), right: unit(size * .18), top: unit(size * .10), background: ink, transform: 'rotate(18deg)' }} /></>}
        <i className="helmet__eye" style={{ width: unit(eye), height: unit(eye * 1.15), left: unit(size * .23), top: unit(size * (confused ? .13 : .14)), background: ink }} />
        <i className="helmet__eye" style={{ width: unit(eye), height: unit(eye * 1.15), right: unit(size * .23), top: unit(size * (confused ? .17 : .14)), background: ink }} />
        <i className="helmet__mouth" style={{ width: unit(eye * (confused ? 1.8 : 1.5)), height: unit(Math.max(1, eye * .3)), left: unit(size * (confused ? .33 : .35)), top: unit(size * .31), background: ink, transform: confused ? 'rotate(-12deg)' : undefined }} />
      </span>
      <i className="helmet__mark" style={{ ...markStyle, top: unit(size * .78) }} />
    </span>
  </span>
}

export function Astronaut({ size, hue, mark, state = 'working', delay = '0s', compact = false }: Props) {
  const unit = (value: number) => `${value}px`
  const helmet = size * 0.6
  const visorWidth = size * 0.42
  const visorHeight = size * 0.32
  const eye = Math.max(2, size * 0.055)
  const markSize = size * 0.09
  const markWidth = { bar: 2.2, dot: 1, two: 2.4, ring: 1.7, diamond: 1.4, square: 1.5 }[mark] * markSize
  const suit = `oklch(.985 .010 ${hue})`
  const shade = `oklch(.905 .035 ${hue})`
  const ink = `oklch(.34 .045 ${hue})`
  const markInk = `oklch(.62 .10 ${hue})`
  const stateColor = { working: 'oklch(.72 .14 155)', waiting: 'oklch(.78 .15 75)', stuck: 'oklch(.64 .19 25)', drift: 'oklch(.66 .16 305)', done: 'oklch(.70 .10 240)', idle: 'oklch(.78 .01 265)' }[state]
  const badge = { working: '', waiting: '?', stuck: '!', drift: '↗', done: '✓', idle: '' }[state]
  const rootStyle = { '--size': unit(size), '--hue': hue, '--state-color': stateColor, animationDelay: delay } as CSSProperties
  const markStyle: CSSProperties = {
    width: unit(markWidth), height: unit(mark === 'ring' ? markSize * 1.7 : mark === 'diamond' || mark === 'square' ? markSize * 1.4 : mark === 'dot' ? markSize : markSize * .7),
    marginLeft: unit(-markWidth / 2), background: mark === 'ring' ? 'transparent' : markInk,
    border: mark === 'ring' ? `${Math.max(1, markSize * .42)}px solid ${markInk}` : undefined,
    borderRadius: mark === 'diamond' ? unit(markSize * .25) : '999px',
    boxShadow: mark === 'two' ? `0 ${unit(markSize * 1.2)} 0 ${markInk}` : undefined,
    transform: mark === 'diamond' ? 'rotate(45deg)' : undefined
  }

  return <div className={`astronaut astronaut--${state}${compact ? ' astronaut--compact' : ''}`} style={rootStyle} aria-hidden="true">
    {badge && <span className="astronaut__badge">{badge}</span>}
    <div className="astronaut__pack" style={{ width: unit(size * .7), height: unit(size * .34), left: unit(size * .15), top: unit(helmet * .96), borderRadius: unit(size * .12), background: shade }} />
    <div className="astronaut__arm astronaut__arm--left" style={{ width: unit(size * .13), height: unit(size * .3), left: unit(size * .16), top: unit(helmet * .95), borderRadius: unit(size * .13), background: shade }} />
    <div className="astronaut__arm astronaut__arm--right" style={{ width: unit(size * .13), height: unit(size * .3), left: unit(size * .71), top: unit(helmet * .95), borderRadius: unit(size * .13), background: shade }} />
    <div className="astronaut__body" style={{ width: unit(size * .54), height: unit(size * .46), left: unit(size * .23), top: unit(helmet * .86), borderRadius: `${unit(size * .2)} ${unit(size * .2)} ${unit(size * .13)} ${unit(size * .13)}`, background: suit, boxShadow: `inset 0 -${unit(Math.max(1, size * .022))} 0 ${shade}` }}>
      <div className="astronaut__chest" style={{ width: unit(size * .11), height: unit(size * .11), top: unit(size * .13), marginLeft: unit(-size * .055) }} />
      <div className="astronaut__mark" style={{ ...markStyle, top: unit(size * .28) }} />
    </div>
    <div className="astronaut__helmet" style={{ width: unit(helmet), height: unit(helmet), left: unit((size - helmet) / 2), background: suit, boxShadow: `inset -${unit(Math.max(1, size * .022))} -${unit(Math.max(1, size * .022))} 0 ${shade}, 0 ${unit(Math.max(1, size * .022))} ${unit(size * .12)} oklch(.55 .04 265 / .16)` }}>
      <div className="astronaut__visor" style={{ width: unit(visorWidth), height: unit(visorHeight), left: unit((helmet - visorWidth) / 2), top: unit(helmet * .26), borderRadius: unit(size * .14), background: `linear-gradient(155deg, oklch(.94 .045 ${hue}), oklch(.80 .095 ${hue}))` }}>
        <i className="astronaut__eye astronaut__eye--left" style={{ width: unit(eye), height: unit(eye * 1.15), left: unit(visorWidth * .26 - eye / 2 - 1.2 * (size * .018)), top: unit(visorHeight * .3), background: ink }} />
        <i className="astronaut__eye astronaut__eye--right" style={{ width: unit(eye), height: unit(eye * 1.15), left: unit(visorWidth * .74 - eye / 2 - 1.2 * (size * .018)), top: unit(visorHeight * .3), background: ink }} />
        <i className="astronaut__mouth" style={{ width: unit(eye * 1.5), height: unit(Math.max(1.3, eye * .3)), left: unit(visorWidth / 2 - eye), top: unit(visorHeight * .62), background: ink }} />
        <i className="astronaut__shine" />
      </div>
    </div>
  </div>
}
