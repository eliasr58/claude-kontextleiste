import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  ResolveInput,
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
/** Id des Panes, in dem die Leiste auch gezeigt werden kann. */
const PANE = 'kontextleiste'

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

/** Die eine Zeile der Leiste; gezeichnet über dem Eingabefeld oder im Pane. */
async function zeichnen($: EngineInterface, e: ResolveInput, spalten: number) {
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
    const breite = Math.max(12, Math.min(40, spalten - textLaenge - 1))
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
}

/** Die Leiste als reiner Text, für Oberflächen ohne Zeichenfläche (Cowork). */
function textzeile(k: Kontext | null, l: Limits | null, jetzt: number): string {
  if (k === null || k.prozent === undefined) return 'Kontext: noch keine Messung (kommt mit der ersten Antwort)'
  const p = Math.max(0, Math.min(100, k.prozent))
  const breite = 30
  const gefuellt = Math.round((p / 100) * breite)
  const zellen = [...'━'.repeat(gefuellt) + '─'.repeat(breite - gefuellt)]
  if (k.kompaktBei !== undefined) zellen.splice(Math.min(breite, Math.round((k.kompaktBei / 100) * breite)), 0, '│')
  const teile = [`${zellen.join('')} ${p} %`]
  if (k.kompaktBei !== undefined) {
    teile.push(k.kompaktBei - p > 0 ? `noch ${k.kompaktBei - p} % bis Kompaktierung` : 'Kompaktierung steht an')
  }
  if (l?.limit5h !== undefined) teile.push(`5h ${Math.round(l.limit5h)} %`)
  if (l?.limit7t !== undefined) teile.push(`W ${Math.round(l.limit7t)} %`)
  const alt = l !== null && jetzt - l.am > ALT_MS ? ` (${alter(jetzt - l.am)})` : ''
  return teile.join(' · ') + alt
}

/** Schwellen, bei denen Cowork einen Hinweis in den Verlauf bekommt. */
const REST_WARNUNGEN = [15, 5] as const
const LIMIT_WARNUNG = 85
/** Schlüssel in $.store: 'warnungen' (Standard) oder 'immer'. */
const STORE_MODUS = 'modus'

/** Bereits gemeldete Schwellen, damit jeder Hinweis nur einmal kommt. */
const gemeldet = new Set<string>()


async function ohneZeichenflaeche($: EngineInterface) {
  return (await $.session.surfaces()).length === 0
}

async function hinweis($: EngineInterface, text: string) {
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
}

/** Meldet überschrittene Schwellen einmal; fällt ein Wert zurück, wird die Schwelle wieder frei. */
async function schwellenPruefen($: EngineInterface) {
  if (!(await ohneZeichenflaeche($))) return
  const k = await read($, kontext)
  const l = await read($, limits)
  const jetzt = await $.clock.now()
  const ausloeser: string[] = []
  if (k?.prozent !== undefined && k.kompaktBei !== undefined) {
    const rest = k.kompaktBei - k.prozent
    for (const w of REST_WARNUNGEN) {
      const key = `rest${w}`
      if (rest <= w && !gemeldet.has(key)) { gemeldet.add(key); ausloeser.push(key) }
      if (rest > w) gemeldet.delete(key)
    }
  }
  for (const [key, wert] of [['5h', l?.limit5h], ['woche', l?.limit7t]] as const) {
    if (wert === undefined) continue
    if (wert >= LIMIT_WARNUNG && !gemeldet.has(key)) { gemeldet.add(key); ausloeser.push(key) }
    if (wert < LIMIT_WARNUNG) gemeldet.delete(key)
  }
  if (ausloeser.length > 0) await hinweis($, `⚠ Kontextleiste: ${textzeile(k, l, jetzt)}`)
}



/** Schlüssel in $.store: die URL der Live-Seite im Seitenbereich. */
const STORE_LIVE = 'liveSeite'
/** Mindestabstand zwischen zwei Schreibvorgängen auf die Live-Seite während einer Runde. */
const LIVE_MIN_MS = 20_000
/** Version des eigenen Dokuments auf der Live-Seite, für if_version. */
let liveVersion: number | undefined
let liveZuletzt = 0

function versionAus(text: string | undefined): number | undefined {
  const m = text ? /"version"\s*:\s*(\d+)/.exec(text) : null
  return m ? Number(m[1]) : undefined
}

/** Schreibt den Stand dieser Sitzung in die Datenbank der Live-Seite. Gibt eine Zeile zum Ergebnis zurück. */
async function liveSchreiben($: EngineInterface): Promise<string> {
  const url = await $.store.get(STORE_LIVE)
  if (typeof url !== 'string' || url === '') return 'keine Live-Seite verbunden'
  const k = await read($, kontext)
  const l = await read($, limits)
  if (k === null || k.prozent === undefined) return 'noch keine Messung'
  const surfaces = await $.session.surfaces()
  const quelle = surfaces.includes('terminal') ? 'terminal' : surfaces.includes('desktop') ? 'desktop' : 'cowork'
  const id = (await $.session.id()).replace(/[^A-Za-z0-9_.~-]/g, '-').slice(0, 120)
  const data: Record<string, unknown> = { prozent: k.prozent, fenster: k.fenster, am: await $.clock.now(), quelle }
  if (k.tokens !== undefined) data.tokens = k.tokens
  if (k.kompaktBei !== undefined) data.kompaktBei = k.kompaktBei
  if (k.anteile) data.anteile = k.anteile
  if (l?.limit5h !== undefined) data.limit5h = l.limit5h
  if (l?.limit7t !== undefined) data.limit7t = l.limit7t
  if (l) data.limitsAm = l.am

  const schreiben = (version: number | undefined) =>
    $.tool.call({
      tool: 'ArtifactData',
      action: 'set',
      url,
      collection: 'sitzungen',
      doc_id: id,
      data,
      ...(version !== undefined ? { if_version: version } : {}),
    } as never)

  let r = await schreiben(liveVersion)
  if (r.deny) return `verweigert: ${r.deny}`
  if (r.isError) {
    // Unbekannte oder veraltete Version: einmal lesen, dann mit der aktuellen Version schreiben.
    const g = await $.tool.call({ tool: 'ArtifactData', action: 'get', url, collection: 'sitzungen', doc_id: id } as never)
    r = await schreiben(versionAus(g.text))
  }
  if (r.isError || r.deny) return `Fehler: ${(r.deny ?? r.text ?? '').slice(0, 300)}`
  liveVersion = versionAus(r.text) ?? liveVersion
  liveZuletzt = await $.clock.now()
  return `geschrieben (Version ${liveVersion ?? '?'})`
}

export const register: Register = on => {
  let bandGezeichnet = false
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({
        name: 'kontextleiste',
        description: 'Zeigt die Kontextleiste als Text; „immer“ / „warnungen“ schaltet den Modus, „status“ zeigt Diagnose',
        argumentHint: '[immer|warnungen|status|verbinden <url>|sync]',
      })
      .catch(() => {})
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
    // Jede Messung bestätigt die Limits neu, auch wenn sich kein ganzer Punkt bewegt hat;
    // sonst zeigt die Altersangabe den Zeitpunkt der letzten Änderung statt der letzten Messung.
    if (e.rateLimits.length > 0) {
      const l = zuLimits(e.rateLimits, await $.clock.now())
      if (l) await limitsMelden($, l).catch(() => {})
    }
    await schwellenPruefen($).catch(() => {})
    if ((await $.clock.now()) - liveZuletzt > LIVE_MIN_MS) await liveSchreiben($).catch(() => '')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await liveSchreiben($).catch(() => '')
    try {
      if ((await $.store.get(STORE_MODUS)) === 'immer' && (await ohneZeichenflaeche($))) {
        await hinweis($, textzeile(await read($, kontext), await read($, limits), await $.clock.now()))
      }
    } catch {
      // Ein fehlender Hinweis darf die Runde nicht stören.
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    bandGezeichnet = true
    return zeichnen($, e, e.props.bodyColumns)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    zeichnen($, e, e.props.bodyColumns),
  )

  on('command.run', { command: 'kontextleiste' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const k = await read($, kontext)
    const l = await read($, limits)
    const jetzt = await $.clock.now()

    if (arg === 'immer' || arg === 'warnungen') {
      await $.store.set(STORE_MODUS, arg)
      return {
        text:
          arg === 'immer'
            ? 'Kontextleiste: Ab jetzt steht nach jeder Antwort eine Zeile mit dem Stand im Verlauf.'
            : 'Kontextleiste: Ab jetzt nur noch Hinweise bei 15 % und 5 % bis zur Kompaktierung und ab 85 % Limit.',
      }
    }
    if (arg.startsWith('verbinden')) {
      const url = e.args.trim().split(/\s+/)[1] ?? ''
      if (!/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(url)) return { text: 'Kontextleiste: Gib die Adresse der Live-Seite mit an, etwa /kontextleiste verbinden https://claude.ai/artifact/…' }
      await $.store.set(STORE_LIVE, url)
      liveVersion = undefined
      return { text: `Kontextleiste: Live-Seite verbunden, erster Abgleich: ${await liveSchreiben($)}` }
    }
    if (arg === 'sync') {
      return { text: `Kontextleiste: ${await liveSchreiben($)}` }
    }
    if (arg === 'test') {
      await hinweis($, `⚠ Kontextleiste (Testhinweis): ${textzeile(k, l, jetzt)}`)
      return { text: 'Kontextleiste: Testhinweis abgelegt.' }
    }
    if (arg === 'status') {
      const surfaces = await $.session.surfaces()
      const offen = surfaces.length > 0 ? (await $.ui.open({ id: PANE, title: 'Kontext' })).isPlaced : false
      const modus = (await $.store.get(STORE_MODUS)) === 'immer' ? 'immer' : 'warnungen'
      return {
        text: [
          'Kontextleiste 0.4.0 ist aktiv.',
          `Oberflächen: ${surfaces.length > 0 ? surfaces.join(', ') : 'keine'}`,
          `Band über dem Eingabefeld gezeichnet: ${bandGezeichnet ? 'ja' : 'nein'}`,
          `Pane geöffnet: ${offen ? 'ja' : 'nein'}`,
          `Modus ohne Zeichenfläche: ${modus}`,
        ].join('\n'),
      }
    }
    return { text: textzeile(k, l, jetzt) }
  })
}
