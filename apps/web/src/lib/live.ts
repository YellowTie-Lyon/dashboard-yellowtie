/**
 * Rythmes d'actualisation automatique (ms). Les agents envoient une fois par minute : 15 s suffisent pour voir une
 * nouvelle donnée moins d'une quinzaine de secondes après son arrivée. L'actualisation se met en pause quand
 * l'onglet est masqué et reprend immédiatement (rafraîchissement au retour sur l'onglet).
 */
export const LIVE = {
  /** États des agents et des Clouds, valeurs affichées sur les cartes. */
  fast: 15_000,
  /** Graphiques courts (1 h / 6 h) et fiches. */
  normal: 30_000,
  /** Listes qui changent rarement (sites, compteurs), graphiques longs, maintenance. */
  slow: 60_000,
} as const
