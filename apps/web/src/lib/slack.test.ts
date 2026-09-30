import { describe, expect, it } from 'vitest'
import { mentionChoice, mentionForInput, parseMentions } from './slack'

describe('parseMentions', () => {
  it('convertit un identifiant de membre en mention', () => expect(parseMentions('U012ABCDEF')).toBe('<@U012ABCDEF>'))
  it('accepte plusieurs éléments séparés par espace ou virgule (3 au plus)', () => {
    expect(parseMentions('U012ABCDEF, S0123ABCDE @here')).toBe('<@U012ABCDEF> <!subteam^S0123ABCDE> <!here>')
    expect(parseMentions('U012ABCDEF U012ABCDEG U012ABCDEH U012ABCDEI')).toBeNull()
  })
  it('accepte une mention déjà formatée', () => expect(parseMentions('<@W0ABCDEFG> <!channel>')).toBe('<@W0ABCDEFG> <!channel>'))
  it('refuse le reste', () => {
    expect(parseMentions('everyone')).toBeNull()
    expect(parseMentions('')).toBeNull()
    expect(parseMentions('julien')).toBeNull()
    expect(parseMentions('U1')).toBeNull()
  })
})

describe('mentionChoice / mentionForInput', () => {
  it('retrouve le choix affiché', () => {
    expect(mentionChoice(null)).toBe('none')
    expect(mentionChoice('<!here>')).toBe('here')
    expect(mentionChoice('<!channel>')).toBe('channel')
    expect(mentionChoice('<@U012ABCDEF>')).toBe('custom')
  })
  it('affiche les identifiants sans chevrons', () => expect(mentionForInput('<@U012ABCDEF> <!subteam^S0123ABCDE>')).toBe('U012ABCDEF S0123ABCDE'))
})
