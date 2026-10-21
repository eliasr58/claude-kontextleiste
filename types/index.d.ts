/** Anteile am belegten Kontext, zusammen 1. */
export type Anteile = {
  system: number
  tools: number
  skills: number
  nachrichten: number
}

/** Kontext dieser Sitzung: gehört nur ihr. */
export type Kontext = {
  /** Eingabe-Tokens der letzten Antwort; fehlt vor der ersten Antwort. */
  tokens?: number
  /** Kontextfenster des Modells in Tokens. */
  fenster: number
  /** Füllstand in Prozent, 0 bis 100. */
  prozent?: number
  /** Wie sich der belegte Kontext aufteilt; fehlt, solange keine Aufschlüsselung vorliegt. */
  anteile?: Anteile
  /** Ab welchem Füllstand (Prozent des Fensters) automatisch kompaktiert wird; fehlt, wenn aus. */
  kompaktBei?: number
}

/** Kontolimits: gelten für alle Sitzungen, werden über $.store geteilt. */
export type Limits = {
  limit5h?: number
  limit7t?: number
  /** Zeitpunkt der Messung in ms seit Epoch. */
  am: number
}

declare module 'claude-code' {
  interface PluginState {
    kontextleiste: { kontext: Kontext | null; limits: Limits | null }
  }
}
