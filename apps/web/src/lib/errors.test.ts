import { describe, expect, it } from 'vitest'
import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('traduit les codes Postgres connus', () => {
    expect(errorMessage({ code: '42501' })).toMatch(/propriétaire/)
    expect(errorMessage({ code: '23505' })).toMatch(/existe déjà/)
    expect(errorMessage({ code: '23514' })).toMatch(/invalide/)
  })

  it('reprend le message des autres erreurs', () => {
    expect(errorMessage({ message: 'boom' })).toBe('boom')
  })

  it('a une valeur par défaut', () => {
    expect(errorMessage(null)).toBe('Erreur inattendue.')
  })
})
