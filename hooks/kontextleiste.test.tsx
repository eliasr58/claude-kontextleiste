import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionRateLimit } from 'claude-code'

const BAND = {
  plugin: 'kontextleiste',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const AUFSCHLUESSELUNG = {
  categories: [
    { name: 'System prompt', tokens: 12_000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 27_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Skills', tokens: 7_000, color: 'success', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 78_000, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 76_000, color: 'subtle', isDeferred: false, kind: 'free' },
  ],
  autoCompactThreshold: 160_000,
  isAutoCompactEnabled: true,
} as unknown as SessionContextBreakdown

/** Geräteweiter Speicher, den mehrere Sitzungen teilen: hier ein Objekt im Test. */
function speicher(on: On, start: Record<string, unknown> = {}) {
  const daten: Record<string, unknown> = { ...start }
  on('store.get', (_, e) => ({ value: daten[e.key] }))
  on('store.set', (_, e) => {
    daten[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  return daten
}

function engine(on: On, rateLimits: SessionRateLimit[]) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 124_000, window: 200_000, percent: 62, breakdown: AUFSCHLUESSELUNG },
      rateLimits,
    },
  }))
}

test('vor der ersten Antwort: Hinweis statt Balken', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /noch keine Messung/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Variante E: Füllstand, Restweg bis Kompaktierung, beide Limits', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const daten = speicher(on)
  engine(on, [
    { kind: 'five_hour', percentUsed: 23 },
    { kind: 'seven_day', percentUsed: 41.5 },
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /62 %/ }))?.text).toBe(' 62 %')
    expect((await ui.find({ type: 'Text', text: /Kompaktierung/ }))?.text).toBe(
      ' · noch 18 % bis Kompaktierung',
    )
    expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('  5h 23 %')
    expect((await ui.find({ type: 'Text', text: /W 42/ }))?.text).toBe('  W 42 %')
    expect(await ui.find({ type: 'Text', text: /│/ })).toBeDefined()
    await ui.unmount()
  }
  // Die gemessenen Limits liegen für die anderen Sitzungen bereit.
  expect(daten.limits).toEqual({ limit5h: 23, limit7t: 41.5, am: 1_000_000 })
})

test('Limits einer anderen Sitzung kommen live an', async ($, on) => {
  const uhr = mock.clock(on, { now: 600_000 })
  const daten = speicher(on, { limits: { limit5h: 70, limit7t: 50, am: 0 } })
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('  5h 70 %')
  expect((await ui.find({ type: 'Text', text: /vor/ }))?.text).toBe(' (vor 10 min)')
  await ui.unmount()

  // Eine andere Sitzung misst neuer; nach dem nächsten Abgleich steht es hier.
  daten.limits = { limit5h: 88, limit7t: 51, am: 600_000 }
  await uhr.advance(15_000)

  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('  5h 88 %')
  expect(await ui.find({ type: 'Text', text: /vor \d/ })).toBeUndefined()
  await ui.unmount()
})
