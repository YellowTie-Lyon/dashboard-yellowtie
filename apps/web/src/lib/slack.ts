/** Formats de mention Slack acceptés par la base (@here, @channel, personne, groupe). */
export type MentionChoice = 'none' | 'here' | 'channel' | 'custom'

export function mentionChoice(mention: string | null | undefined): MentionChoice {
  if (!mention) return 'none'
  if (mention === '<!here>') return 'here'
  if (mention === '<!channel>') return 'channel'
  return 'custom'
}

/**
 * Convertit ce que l'utilisateur saisit (« U012ABCDEF », « S0123ABC », ou déjà « <@U012ABCDEF> ») en mentions Slack.
 * Un identifiant de membre commence par U ou W, celui d'un groupe d'utilisateurs par S. Renvoie null si un élément est invalide.
 */
export function parseMentions(input: string): string | null {
  const tokens = input.split(/[\s,;]+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > 3) return null
  const out: string[] = []
  for (const raw of tokens) {
    const t = raw.trim()
    let m: RegExpMatchArray | null
    if ((m = t.match(/^<@([UW][A-Z0-9]{6,15})>$/)) || (m = t.match(/^@?([UW][A-Z0-9]{6,15})$/))) out.push(`<@${m[1]}>`)
    else if ((m = t.match(/^<!subteam\^(S[A-Z0-9]{6,15})>$/)) || (m = t.match(/^(S[A-Z0-9]{6,15})$/))) out.push(`<!subteam^${m[1]}>`)
    else if (t === '<!here>' || t === '@here') out.push('<!here>')
    else if (t === '<!channel>' || t === '@channel') out.push('<!channel>')
    else return null
  }
  return out.join(' ')
}

/** Affichage lisible d'une mention enregistrée dans le champ de saisie (« U012ABCDEF »). */
export function mentionForInput(mention: string | null | undefined): string {
  return (mention ?? '').replace(/<@([UW][A-Z0-9]+)>/g, '$1').replace(/<!subteam\^(S[A-Z0-9]+)>/g, '$1')
}
