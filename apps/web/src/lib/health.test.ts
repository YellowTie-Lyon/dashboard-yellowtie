import { describe, expect, it } from 'vitest'
import { formatSize, JOBS, jobHealth, storageLevel } from './health'

const now = Date.parse('2026-09-30T12:00:00Z')
const spec = (name: string) => JOBS.find((j) => j.name === name)!
const ago = (ms: number) => new Date(now - ms).toISOString()

describe('jobHealth', () => {
  it('ok quand la tâche a tourné récemment', () => {
    const h = jobHealth(spec('evaluate'), [{ name: 'evaluate', last_run_at: ago(60_000), detail: {} }], now)
    expect(h).toMatchObject({ level: 'ok', problem: false })
  })
  it('en retard au-delà de la tolérance', () => {
    const h = jobHealth(spec('rollup'), [{ name: 'rollup', last_run_at: ago(30 * 60_000), detail: {} }], now)
    expect(h).toMatchObject({ level: 'late', problem: true })
  })
  it('jamais exécutée : problème seulement pour les tâches essentielles', () => {
    expect(jobHealth(spec('evaluate'), [], now)).toMatchObject({ level: 'never', problem: true })
    expect(jobHealth(spec('probes'), [], now)).toMatchObject({ level: 'never', problem: false })
  })
  it('la purge quotidienne tolère 26 h', () => {
    expect(jobHealth(spec('purge'), [{ name: 'purge', last_run_at: ago(25 * 3600_000), detail: {} }], now).problem).toBe(false)
    expect(jobHealth(spec('purge'), [{ name: 'purge', last_run_at: ago(27 * 3600_000), detail: {} }], now).problem).toBe(true)
  })
})

describe('storage', () => {
  const mb = 1024 * 1024
  it('niveaux', () => {
    expect(storageLevel(100 * mb)).toBe('ok')
    expect(storageLevel(350 * mb)).toBe('warning')
    expect(storageLevel(460 * mb)).toBe('critical')
  })
  it('formatSize', () => {
    expect(formatSize(512)).toBe('512 o')
    expect(formatSize(5 * mb)).toMatch(/^5\s?Mo$/)
    expect(formatSize(1.5 * 1024 * mb)).toMatch(/^1,5\s?Go$/)
  })
})
