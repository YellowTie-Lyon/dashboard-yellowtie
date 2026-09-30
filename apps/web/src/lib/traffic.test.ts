import { describe, expect, it } from 'vitest'
import { formatCount, formatRate, formatShare, hostingShares } from './traffic'
import type { DomainTrafficRow } from './types'

const row = (o: Partial<DomainTrafficRow>): DomainTrafficRow => ({
  domain: 'a.fr', web_hosting_id: 'h1', hosting_name: 'H1', requests: 10, bytes: 0, r4xx: 0, r5xx: 0, posts: 0, bots: 0, share: null, ...o,
})

describe('hostingShares', () => {
  it('regroupe par hébergement, calcule la part et trie', () => {
    const shares = hostingShares([
      row({ domain: 'a.fr', requests: 60, r5xx: 5 }),
      row({ domain: 'b.fr', requests: 20 }),
      row({ domain: 'c.fr', web_hosting_id: 'h2', hosting_name: 'H2', requests: 20 }),
    ])
    expect(shares.map((s) => s.hostingId)).toEqual(['h1', 'h2'])
    expect(shares[0]).toMatchObject({ requests: 80, share: 80, errors5xx: 5 })
    expect(shares[1]?.share).toBe(20)
  })
  it('renvoie une liste vide sans trafic', () => expect(hostingShares([])).toEqual([]))
})

describe('formats', () => {
  it('formatRate', () => {
    expect(formatRate(600, 60)).toBe('10 req/min')
    expect(formatRate(6, 60)).toBe('0,1 req/min')
  })
  it('formatCount', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(25_000)).toMatch(/^25\s?k$/)
    expect(formatCount(2_500_000)).toMatch(/^2,5\s?M$/)
  })
  it('formatShare', () => {
    expect(formatShare(47.3)).toMatch(/^47\s?%$/)
    expect(formatShare(4.26)).toMatch(/^4,3\s?%$/)
    expect(formatShare(null)).toBe('—')
  })
})
