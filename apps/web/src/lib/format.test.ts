import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatDuration,
  formatLoad,
  formatMb,
  formatPercent,
  formatRelativeTime,
  formatUptime,
} from './format'

const NOW = Date.parse('2026-09-30T10:00:00Z')

describe('formatRelativeTime', () => {
  it.each([
    [0, "à l'instant"],
    [4, "à l'instant"],
    [32, 'il y a 32 s'],
    [59, 'il y a 59 s'],
    [60, 'il y a 1 min'],
    [3599, 'il y a 59 min'],
    [3600, 'il y a 1 h'],
    [47 * 3600, 'il y a 47 h'],
    [48 * 3600, 'il y a 2 j'],
  ])('%i s → %s', (secondsAgo, expected) => {
    expect(formatRelativeTime(NOW - secondsAgo * 1000, NOW)).toBe(expected)
  })

  it("traite un horodatage futur (dérive d'horloge) comme « à l'instant »", () => {
    expect(formatRelativeTime(NOW + 30_000, NOW)).toBe("à l'instant")
  })

  it('accepte une chaîne ISO', () => {
    expect(formatRelativeTime('2026-09-30T09:59:28Z', NOW)).toBe('il y a 32 s')
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0 s'],
    [45, '45 s'],
    [17 * 60, '17 min'],
    [2 * 3600 + 5 * 60, '2 h 05'],
  ])('%i s → %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected)
  })
})

describe('formatPercent / formatLoad', () => {
  it('formate en français avec virgule', () => {
    expect(formatPercent(18)).toBe('18 %')
    expect(formatPercent(32.44)).toBe('32,4 %')
    expect(formatLoad(0.62)).toBe('0,62')
    expect(formatLoad(5)).toBe('5,00')
  })

  it('affiche un tiret quand la valeur est absente', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(undefined)).toBe('—')
    expect(formatLoad(null)).toBe('—')
  })
})

describe('formatMb / formatBytes', () => {
  it.each([
    [512, '512 Mo'],
    [36093, '35,2 Go'],
    [281589, '275 Go'],
    [2 * 1024 * 1024, '2 To'],
  ])('%i Mo → %s', (mb, expected) => {
    expect(formatMb(mb)).toBe(expected)
  })

  it.each([
    [900, '900 o'],
    [5000, '4,9 Ko'],
    [16733972, '16 Mo'],
    [3 * 1024 ** 3, '3 Go'],
  ])('%i octets → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('formatUptime', () => {
  it.each([
    [600, '10 min'],
    [5 * 3600 + 3 * 60, '5 h 03'],
    [14 * 86400 + 6 * 3600, '14 j 06 h'],
  ])('%i s → %s', (s, expected) => {
    expect(formatUptime(s)).toBe(expected)
  })
})
