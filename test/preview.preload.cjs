const listeners = {}
const worker = {
  id: 'preview-session', name: 'Wren', title: 'Fix booking timezone', action: 'Reading bookingDate.ts',
  context: { label: 'File', text: 'src/booking/bookingDate.ts', code: true },
  state: 'working', presentation: 'working', priority: 'P2', hue: 25, mark: 'bar', delay: '-.7s'
}
window.previewTest = {
  worker, opened: [], modes: [], failOpen: false,
  update(patch) { Object.assign(worker, patch); listeners.workers?.([{ ...worker }]) }
}
window.orbit = {
  getWorkers: async () => [{ ...worker }],
  setMode: async mode => { window.previewTest.modes.push(mode); listeners.mode?.(mode) },
  openSession: async id => { window.previewTest.opened.push(id); return window.previewTest.failOpen ? { ok: false, message: 'Session unavailable' } : { ok: true } },
  onMode: callback => { listeners.mode = callback; return () => { delete listeners.mode } },
  onWorkersUpdated: callback => { listeners.workers = callback; return () => { delete listeners.workers } },
  onToggle: () => () => {}, onPointerLeftWindow: () => () => {},
  dragStart: async () => ({ x: 0, y: 0 }), dragMove: async () => {}, dragEnd: async () => {}
}
