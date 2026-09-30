import { describe, expect, it } from 'vitest'
import { buildRows, formatTick, lastValue, RANGES, rangeSpec, timeTicks, windowSpec } from './series'
import type { SeriesPoint } from './types'

function point(ts: string, over: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    ts, n: 1, load1_avg: 1, load1_max: 2, load5_avg: 1, load15_avg: 1, cpu_pct_avg: 10, cpu_pct_max: 20,
    mem_used_pct_avg: 30, mem_used_pct_max: 31, swap_used_pct_avg: 5, swap_used_pct_max: 6,
    disk_used_pct_avg: 50, disk_used_pct_max: 50, ...over,
  }
}

describe('RANGES', () => {
  it('couvre les 5 périodes demandées, chacune avec moins de 800 points', () => {
    expect(RANGES.map((r) => r.key)).toEqual(['1h', '6h', '24h', '7d', '30d'])
    for (const r of RANGES) expect(r.durationMs / r.stepMs).toBeLessThanOrEqual(800)
  })

  it('marque comme « tranches » toutes les périodes de 24 h et plus', () => {
    expect(RANGES.filter((r) => r.bucketed).map((r) => r.key)).toEqual(['24h', '7d', '30d'])
  })

  it('retombe sur 24 h pour une période inconnue', () => {
    expect(rangeSpec('nimportequoi' as never).key).toBe('24h')
  })
})

describe('buildRows', () => {
  it('convertit les points en lignes horodatées en ms', () => {
    const rows = buildRows([point('2026-09-30T10:00:00Z')], 60_000)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.t).toBe(Date.parse('2026-09-30T10:00:00Z'))
    expect(rows[0]?.load1Max).toBe(2)
  })

  it('ne comble pas un trou : une ligne vide coupe le trait', () => {
    const rows = buildRows([point('2026-09-30T10:00:00Z'), point('2026-09-30T10:01:00Z'), point('2026-09-30T10:30:00Z')], 60_000)
    expect(rows).toHaveLength(4)
    expect(rows[2]?.load1).toBeNull()
    expect(rows[2]?.n).toBe(0)
    expect(rows[3]?.load1).toBe(1)
  })

  it('ne crée pas de trou pour un retard d’une minute', () => {
    const rows = buildRows([point('2026-09-30T10:00:00Z'), point('2026-09-30T10:01:30Z')], 60_000)
    expect(rows).toHaveLength(2)
  })

  it('applique le pas de la période pour détecter les trous', () => {
    // 2 tranches de 5 min consécutives : pas de trou ; 1 tranche manquante (10 min d'écart) : trou seulement au-delà de 7,5 min
    const ok = buildRows([point('2026-09-30T10:00:00Z'), point('2026-09-30T10:05:00Z')], 300_000)
    expect(ok).toHaveLength(2)
    const gap = buildRows([point('2026-09-30T10:00:00Z'), point('2026-09-30T10:10:00Z')], 300_000)
    expect(gap).toHaveLength(3)
  })

  it('accepte un CPU nul (premier relevé)', () => {
    const rows = buildRows([point('2026-09-30T10:00:00Z', { cpu_pct_avg: null, cpu_pct_max: null })], 60_000)
    expect(rows[0]?.cpu).toBeNull()
    expect(rows[0]?.n).toBe(1)
  })
})

describe('timeTicks', () => {
  it.each([
    ['1h', 10 * 60_000],
    ['6h', 3_600_000],
    ['24h', 4 * 3_600_000],
  ] as const)('%s : repères réguliers, dans l’intervalle', (key, tickMs) => {
    const spec = rangeSpec(key)
    const to = Date.parse('2026-09-30T10:07:31Z')
    const from = to - spec.durationMs
    const ticks = timeTicks(from, to, tickMs)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks.length).toBeLessThanOrEqual(8)
    expect(ticks.every((t) => t >= from && t <= to)).toBe(true)
    expect(ticks.every((t, i) => i === 0 || t - (ticks[i - 1] ?? 0) === tickMs)).toBe(true)
  })

  it('pour 7 j et 30 j, donne des repères raisonnables', () => {
    const to = Date.parse('2026-09-30T10:00:00Z')
    expect(timeTicks(to - rangeSpec('7d').durationMs, to, rangeSpec('7d').tickMs).length).toBeGreaterThanOrEqual(6)
    expect(timeTicks(to - rangeSpec('30d').durationMs, to, rangeSpec('30d').tickMs).length).toBeLessThanOrEqual(7)
  })
})

describe('formatTick / lastValue', () => {
  it('affiche l’heure sur 24 h et la date au-delà', () => {
    const t = Date.parse('2026-09-30T10:07:00Z')
    expect(formatTick(t, 'time')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatTick(t, 'date')).toMatch(/^\d{2}\/\d{2}$/)
  })

  it('renvoie la dernière valeur non nulle', () => {
    const rows = buildRows([point('2026-09-30T10:00:00Z', { cpu_pct_avg: 12 }), point('2026-09-30T10:01:00Z', { cpu_pct_avg: null })], 60_000)
    expect(lastValue(rows, 'cpu')).toBe(12)
    expect(lastValue([], 'cpu')).toBeNull()
  })
})

describe('windowSpec', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z')
  const H = 3_600_000

  it('utilise les relevés d\u20191 minute sur une fenêtre courte', () => {
    const w = windowSpec(NOW - 3 * H, NOW, NOW)
    expect(w.stepMs).toBe(60_000)
    expect(w.bucketed).toBe(false)
    expect(w.axis).toBe('time')
  })

  it('regroupe en tranches au-delà de ~12 h pour rester sous 700 points', () => {
    const w = windowSpec(NOW - 3 * 24 * H, NOW, NOW)
    expect(w.durationMs / w.stepMs).toBeLessThanOrEqual(700)
    expect(w.bucketed).toBe(true)
    expect(w.axis).toBe('date')
  })

  it('bascule sur les agrégats horaires avant 34 jours', () => {
    const w = windowSpec(NOW - 60 * 24 * H, NOW - 59 * 24 * H, NOW)
    expect(w.stepMs).toBe(3_600_000)
    expect(w.resolution).toBe('tranches de 1 h')
  })

  it('choisit des repères lisibles (4 à 8 par graphique)', () => {
    for (const hours of [1, 6, 30, 100, 700]) {
      const w = windowSpec(NOW - hours * H, NOW, NOW)
      const count = w.durationMs / w.tickMs
      expect(count).toBeGreaterThanOrEqual(2)
      expect(count).toBeLessThanOrEqual(8)
    }
  })
})
