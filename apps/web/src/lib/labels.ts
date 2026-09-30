/**
 * Vocabulaire centralisé de l'interface.
 *
 * Règle produit : un volume HTTP élevé n'est jamais présenté comme une cause. Les libellés de
 * trafic ci-dessous parlent de corrélation ("potentiellement impliqué"), jamais de responsabilité.
 * Aucun autre fichier ne doit écrire ces formulations en dur.
 */

export type ServerStatus = 'normal' | 'warning' | 'critical' | 'offline' | 'unknown' | 'observing'

export const STATUS_LABELS: Record<ServerStatus, string> = {
  normal: 'Normal',
  warning: 'Warning',
  critical: 'Critical',
  offline: 'Offline',
  unknown: 'Aucune donnée',
  // Des relevés arrivent mais les seuils ne sont pas encore évalués (phase 5) : mode observation.
  observing: 'En observation',
}

export const TRAFFIC_LABELS = {
  topTraffic: "Top trafic pendant l'incident",
  potentialHosting: 'Hébergement potentiellement impliqué',
  potentialDomain: 'Domaine potentiellement impliqué',
  abnormalActivity: 'Activité anormale',
} as const

/** Anomalies détectées côté serveur sur un agent (web_hosting_state.anomaly). */
export const ANOMALY_LABELS: Record<string, string> = {
  points_ignored:
    "Cet agent envoie des relevés système alors qu'il n'est pas le collecteur de son Cloud : ils sont ignorés.",
  hostname_mismatch:
    "Le hostname de cet agent diffère de celui de son Server Cloud : vérifiez que l'hébergement est rattaché au bon Cloud.",
}
