import type { SeriesPoint, SeriesRange } from './types'

export interface RangeSpec {
  key: SeriesRange
  label: string
  durationMs: number
  /** Pas d'une tranche (ms) : sert à détecter les trous (agent silencieux) et à placer les repères. */
  stepMs: number
  /** Vrai quand chaque point est une tranche (moyenne + pic), faux quand c'est un relevé brut. */
  bucketed: boolean
  resolution: string
  tickMs: number
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const RANGES: RangeSpec[] = [
  { key: '1h', label: '1 h', durationMs: HOUR, stepMs: MIN, bucketed: false, resolution: '1 point par minute', tickMs: 10 * MIN },
  { key: '6h', label: '6 h', durationMs: 6 * HOUR, stepMs: MIN, bucketed: false, resolution: '1 point par minute', tickMs: HOUR },
  { key: '24h', label: '24 h', durationMs: DAY, stepMs: 5 * MIN, bucketed: true, resolution: 'tranches de 5 min', tickMs: 4 * HOUR },
  { key: '7d', label: '7 j', durationMs: 7 * DAY, stepMs: 15 * MIN, bucketed: true, resolution: 'tranches de 15 min', tickMs: DAY },
  { key: '30d', label: '30 j', durationMs: 30 * DAY, stepMs: HOUR, bucketed: true, resolution: 'tranches d’1 h', tickMs: 5 * DAY },
]

export function rangeSpec(key: SeriesRange): RangeSpec {
  return RANGES.find((r) => r.key === key) ?? RANGES[2]!
}

/** Ligne de graphique : `t` en ms ; toutes les valeurs à null = trou (aucun relevé reçu). */
export interface SeriesRow {
  t: number
  load1: number | null
  load1Max: number | null
  load5: number | null
  load15: number | null
  cpu: number | null
  cpuMax: number | null
  mem: number | null
  memMax: number | null
  swap: number | null
  swapMax: number | null
  disk: number | null
  diskMax: number | null
  n: number
}

const EMPTY: Omit<SeriesRow, 't'> = {
  load1: null, load1Max: null, load5: null, load15: null, cpu: null, cpuMax: null,
  mem: null, memMax: null, swap: null, swapMax: null, disk: null, diskMax: null, n: 0,
}

/**
 * Transforme les points du serveur en lignes de graphique. Une interruption (agent silencieux, serveur injoignable)
 * est matérialisée par une ligne vide : le trait est coupé, on ne relie jamais deux points séparés par un trou.
 */
export function buildRows(points: SeriesPoint[], range: SeriesRange): SeriesRow[] {
  const { stepMs } = rangeSpec(range)
  const rows: SeriesRow[] = []
  for (const p of points) {
    const t = new Date(p.ts).getTime()
    const prev = rows[rows.length - 1]
    if (prev && prev.n > 0 && t - prev.t > stepMs * 1.5) rows.push({ ...EMPTY, t: prev.t + stepMs })
    rows.push({
      t,
      load1: p.load1_avg, load1Max: p.load1_max, load5: p.load5_avg, load15: p.load15_avg,
      cpu: p.cpu_pct_avg, cpuMax: p.cpu_pct_max,
      mem: p.mem_used_pct_avg, memMax: p.mem_used_pct_max,
      swap: p.swap_used_pct_avg, swapMax: p.swap_used_pct_max,
      disk: p.disk_used_pct_avg, diskMax: p.disk_used_pct_max,
      n: p.n,
    })
  }
  return rows
}

/** Repères de l'axe du temps, alignés sur l'heure locale (minuit pour les pas d'un jour ou plus). */
export function timeTicks(from: number, to: number, tickMs: number): number[] {
  const offset = new Date(from).getTimezoneOffset() * MIN
  const ticks: number[] = []
  for (let t = Math.ceil((from - offset) / tickMs) * tickMs + offset; t <= to; t += tickMs) ticks.push(t)
  return ticks
}

const hm = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
const dm = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' })
const full = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export function formatTick(t: number, range: SeriesRange): string {
  return range === '7d' || range === '30d' ? dm.format(t) : hm.format(t)
}

export function formatMoment(t: number): string {
  return full.format(t)
}

/** Dernière valeur non nulle d'une colonne (valeur « actuelle » affichée dans l'en-tête d'un graphique). */
export function lastValue(rows: SeriesRow[], key: keyof SeriesRow): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]?.[key]
    if (typeof v === 'number') return v
  }
  return null
}
