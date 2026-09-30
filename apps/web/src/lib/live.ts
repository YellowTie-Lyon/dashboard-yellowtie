/**
 * Actualisation automatique SYNCHRONISÉE.
 *
 * Les agents envoient une fois par minute. Toutes les données affichées (mesures, statuts, courbes, hébergements, classement des
 * domaines, incidents…) sont rechargées EN MÊME TEMPS par un seul minuteur central (<LiveSync />, toutes les LIVE_SYNC_MS), au lieu
 * d'un minuteur par requête : à l'écran, tout provient du même instant et rien n'est en avance sur le reste.
 * Le minuteur se met en pause quand l'onglet est masqué ; au retour sur l'onglet, un rechargement immédiat a lieu.
 *
 * Les anciennes valeurs par requête sont désactivées (`false`) mais gardées pour ne pas toucher chaque appel.
 */
export const LIVE_SYNC_MS = 30_000

export const LIVE = {
  fast: false,
  normal: false,
  slow: false,
} as const
