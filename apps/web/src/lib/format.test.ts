import { describe, expect, it } from 'vitest'
import { formatDuration, formatRelativeTime } from './format'

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
