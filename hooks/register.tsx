import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextBreakdown,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { Anteile, Kontext, Limits } from '../types'

const kontext = atom({ plugin: 'kontextleiste', key: 'kontext' } as const, null)
const limits = atom({ plugin: 'kontextleiste', key: 'limits' } as const, null)

/** Schlüssel im geräteweiten Speicher, über den sich Sitzungen die Limits teilen. */
const STORE_LIMITS = 'limits'
/** Wie oft eine Sitzung nachsieht, ob eine andere neuere Limits gemessen hat. */
const ABGLEICH_MS = 15_000
/** Ab diesem Alter zeigt die Leiste, wie alt die Limits sind. */
const ALT_MS = 2 * 60_000

const FARBE = {
  gruen: '#639922',
  gelb: '#EF9F27',
  rot: '#E24B4A',
  system: '#888780',
  tools: '#7F77DD',
  skills: '#1D9E75',
  nachrichten: '#378ADD',
} as const

const ampel = (p: number) => (p >= 85 ? FARBE.rot : p >= 60 ? FARBE.gelb : FARBE.gruen)

/** Ordnet die Zeilen von /context den vier Gruppen der Leiste zu. */
function gruppe(name: string): keyof Anteile {
  if (/message/i.test(name)) return 'nachrichten'
  if (/skill/i.test(name)) return 'skills'
  if (/tool|mcp|command/i.test(name)) return 'tools'
  return 'system'
}

function zuAnteilen(b: SessionContextBreakdown): Anteile | undefined {
  const summe: Anteile = { system: 0, tools: 0, skills: 0, nachrichten: 0 }
  for (const row of b.categories) {
    if (row.kind !== 'used') continue
    summe[gruppe(row.name)] += row.tokens
  }
  const total = summe.system + summe.tools + summe.skills + summe.nachrichten
  if (total <= 0) return undefined
  return {
    system: summe.system / total,
    tools: summe.tools / total,
    skills: summe.skills / total,
    nachrichten: summe.nachrichten / total,
  }
}

function zuKontext(c: SessionContextUsage, b?: SessionContextBreakdown): Kontext {
  const k: Kontext = { tokens: c.tokens, fenster: c.window, prozent: c.percent }
  if (b) {
    k.anteile = zuAnteilen(b)
    if (b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && c.window > 0) {
      k.kompaktBei = Math.round((b.autoCompactThreshold / c.window) * 100)
    }
  }
  return k
}

function zuLimits(rl: SessionRateLimit[], am: number): Limits | null {
  const wert = (kind: string) => rl.find(l => l.kind === kind)?.percentUsed
  const l: Limits = { limit5h: wert('five_hour'), limit7t: wert('seven_day'), am }
  return l.limit5h === undefined && l.limit7t === undefined ? null : l
}

function istLimits(v: unknown): v is Limits {
  return typeof v === 'object' && v !== null && typeof (v as Limits).am === 'number'
}

/** Neuere Limits übernehmen und für die anderen Sitzungen ablegen. */
async function limitsMelden($: EngineInterface, neu: Limits) {
  await update($, limits, alt => (alt !== null && alt.am >= neu.am ? alt : neu))
  const geteilt = await $.store.get(STORE_LIMITS)
  if (!istLimits(geteilt) || geteilt.am < neu.am) await $.store.set(STORE_LIMITS, neu)
}

/** Limits einer anderen Sitzung übernehmen, wenn sie neuer sind. */
async function limitsAbgleichen($: EngineInterface) {
  const geteilt = await $.store.get(STORE_LIMITS)
  if (!istLimits(geteilt)) return
  await update($, limits, alt => (alt !== null && alt.am >= geteilt.am ? alt : geteilt))
}

async function messen($: EngineInterface) {
  const u = await $.session.usage({ breakdown: 'summary' })
  await update($, kontext, () => zuKontext(u.context, u.context.breakdown))
  const l = zuLimits(u.rateLimits, await $.clock.now())
  if (l) await limitsMelden($, l)
}

function alter(ms: number): string {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `vor ${min} min` : `vor ${Math.round(min / 60)} h`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await limitsAbgleichen($).catch(() => {})
    await messen($).catch(() => {})
    $.clock.every(ABGLEICH_MS, () => {
      void limitsAbgleichen($).catch(() => {})
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) {
      // Aufschlüsselung nur bei geändertem Kontext; lokal geschätzt, kostet keine Tokens.
      const u = await $.session
        .usage({ breakdown: 'summary' })
        .catch(() => undefined)
      await update($, kontext, () => zuKontext(e.context, u?.context.breakdown))
    }
    if (e.changed.includes('rateLimits')) {
      const l = zuLimits(e.rateLimits, await $.clock.now())
      if (l) await limitsMelden($, l).catch(() => {})
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const k = await read($, kontext)
    const l = await read($, limits)
    const { Box, Text } = $.ui.resolve(e)

    if (k === null || k.prozent === undefined) {
      return (
        <Box>
          <Text dimColor>Kontext: noch keine Messung (kommt mit der ersten Antwort)</Text>
        </Box>
      )
    }

    const p = Math.max(0, Math.min(100, k.prozent))
    const prozentText = ` ${p} %`
    const rest =
      k.kompaktBei === undefined
        ? ''
        : k.kompaktBei - p > 0
          ? ` · noch ${k.kompaktBei - p} % bis Kompaktierung`
          : ' · Kompaktierung steht an'

    const jetzt = await $.clock.now()
    const limitTeile: { text: string; p: number }[] = []
    if (l?.limit5h !== undefined) limitTeile.push({ text: `5h ${Math.round(l.limit5h)} %`, p: l.limit5h })
    if (l?.limit7t !== undefined) limitTeile.push({ text: `W ${Math.round(l.limit7t)} %`, p: l.limit7t })
    const altText = l !== null && jetzt - l.am > ALT_MS ? ` (${alter(jetzt - l.am)})` : ''
    const punkte = k.anteile ? '  ●●●●' : ''

    const textLaenge =
      prozentText.length +
      rest.length +
      limitTeile.reduce((n, t) => n + 2 + t.text.length, 0) +
      altText.length +
      punkte.length
    const breite = Math.max(12, Math.min(40, e.props.bodyColumns - textLaenge - 1))
    const gefuellt = Math.round((p / 100) * breite)
    const marke =
      k.kompaktBei !== undefined ? Math.min(breite, Math.round((k.kompaktBei / 100) * breite)) : -1

    // Zellen des Balkens: gefüllte nach Inhalt (oder Ampel), dann leer; Marke dazwischen.
    const zellen: { zeichen: string; farbe?: string }[] = []
    if (k.anteile) {
      const reihen: [keyof Anteile, string][] = [
        ['system', FARBE.system],
        ['tools', FARBE.tools],
        ['skills', FARBE.skills],
        ['nachrichten', FARBE.nachrichten],
      ]
      let vergeben = 0
      reihen.forEach(([g, farbe], i) => {
        const n =
          i === reihen.length - 1
            ? gefuellt - vergeben
            : Math.min(gefuellt - vergeben, Math.round(k.anteile![g] * gefuellt))
        for (let j = 0; j < n; j++) zellen.push({ zeichen: '━', farbe })
        vergeben += Math.max(0, n)
      })
    } else {
      for (let j = 0; j < gefuellt; j++) zellen.push({ zeichen: '━', farbe: ampel(p) })
    }
    while (zellen.length < breite) zellen.push({ zeichen: '─' })
    if (marke >= 0) zellen.splice(marke, 0, { zeichen: '│', farbe: FARBE.rot })

    // Gleichfarbige Nachbarzellen zu einem Text zusammenfassen.
    const laeufe: { text: string; farbe?: string }[] = []
    for (const z of zellen) {
      const letzter = laeufe[laeufe.length - 1]
      if (letzter && letzter.farbe === z.farbe) letzter.text += z.zeichen
      else laeufe.push({ text: z.zeichen, farbe: z.farbe })
    }

    return (
      <Box>
        {laeufe.map(lauf =>
          lauf.farbe ? (
            <Text color={lauf.farbe} mono>{lauf.text}</Text>
          ) : (
            <Text dimColor mono>{lauf.text}</Text>
          ),
        )}
        <Text color={ampel(p)} tabular>{prozentText}</Text>
        <Text dimColor>{rest}</Text>
        {limitTeile.map(t => (
          <Text color={ampel(t.p)} tabular>{`  ${t.text}`}</Text>
        ))}
        <Text dimColor>{altText}</Text>
        {k.anteile ? (
          <Text>
            {'  '}
            <Text color={FARBE.system}>●</Text>
            <Text color={FARBE.tools}>●</Text>
            <Text color={FARBE.skills}>●</Text>
            <Text color={FARBE.nachrichten}>●</Text>
          </Text>
        ) : null}
      </Box>
    )
  })
}
