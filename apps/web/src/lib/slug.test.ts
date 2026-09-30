import { describe, expect, it } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it.each([
    ['YellowTie Server Cloud 1', 'yellowtie-server-cloud-1'],
    ['  Été   Café  ', 'ete-cafe'],
    ['Web-Cloud-GRENKE-1', 'web-cloud-grenke-1'],
    ['---', ''],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })

  it('tronque à 60 caractères sans tiret final', () => {
    const slug = slugify(`${'a'.repeat(59)} b`)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })
})
