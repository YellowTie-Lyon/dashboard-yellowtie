/**
 * Vocabulaire centralisé de l'interface.
 *
 * Règle produit : un volume HTTP élevé n'est jamais présenté comme une cause. Les libellés de
 * trafic ci-dessous parlent de corrélation ("potentiellement impliqué"), jamais de responsabilité.
 * Aucun autre fichier ne doit écrire ces formulations en dur.
 */

export type ServerStatus = 'normal' | 'warning' | 'critical' | 'offline'

export const STATUS_LABELS: Record<ServerStatus, string> = {
  normal: 'Normal',
  warning: 'Warning',
  critical: 'Critical',
  offline: 'Offline',
}

export const TRAFFIC_LABELS = {
  topTraffic: "Top trafic pendant l'incident",
  potentialHosting: 'Hébergement potentiellement impliqué',
  potentialDomain: 'Domaine potentiellement impliqué',
  abnormalActivity: 'Activité anormale',
} as const
