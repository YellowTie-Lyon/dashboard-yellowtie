import { describe, expect, it } from 'vitest'
import { generatePassword } from './password'

describe('generatePassword', () => {
  it('produit la longueur demandée (16 par défaut)', () => {
    expect(generatePassword()).toHaveLength(16)
    expect(generatePassword(24)).toHaveLength(24)
  })
  it("n'utilise aucun caractère ambigu", () => {
    for (let i = 0; i < 50; i++) expect(generatePassword(40)).not.toMatch(/[0OIl1 ]/)
  })
  it('est différent à chaque appel', () => {
    expect(generatePassword()).not.toBe(generatePassword())
  })
})
