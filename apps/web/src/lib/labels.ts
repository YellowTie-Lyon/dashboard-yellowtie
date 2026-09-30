/**
 * Vocabulaire centralisé de l'interface.
 *
 * Règle produit : un volume HTTP élevé n'est jamais présenté comme une cause. Les libellés de
 * trafic ci-dessous parlent de corrélation ("potentiellement impliqué"), jamais de responsabilité.
 * Aucun autre fichier ne doit écrire ces formulations en dur.
 */

export type ServerStatus = 'normal' | 'warning' | 'critical' | 'offline' | 'unknown' | 'maintenance'

export const STATUS_LABELS: Record<ServerStatus, string> = {
  normal: 'Normal',
  warning: 'Warning',
  critical: 'Critical',
  offline: 'Offline',
  unknown: 'Aucune donnée',
  maintenance: 'Maintenance',
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
  backup_collector:
    "Cet agent relaie temporairement les relevés système : le collecteur habituel du Cloud ne répond plus (étouffé ou arrêté).",
  hostname_mismatch:
    "Le hostname de cet agent diffère de celui de son Server Cloud : vérifiez que l'hébergement est rattaché au bon Cloud.",
}

/**
 * Diagnostic d'un silence. Formulations volontairement prudentes : le mode « push » ne permet jamais d'affirmer
 * qu'un serveur est arrêté, seulement de conclure qu'une cause est probable.
 */
export const DIAGNOSIS_LABELS = {
  agents_silent: "Les sondes répondent mais aucun agent n'envoie de données : agent ou cron probablement arrêté.",
  unreachable_probable: "Aucun agent ne répond et les sondes échouent : Server Cloud potentiellement inaccessible.",
  unknown_cause: "Aucun agent ne répond. Cause indéterminée (aucune sonde exploitable : configurez-en une par hébergement).",
} as const

export const CONNECTIVITY_LABELS = {
  delayed: 'Données en retard (moins que le seuil offline).',
  metrics_stale: "Le collecteur système est silencieux alors que d'autres agents répondent : les valeurs système sont obsolètes.",
  never: "Aucun agent n'a encore envoyé de données.",
} as const
