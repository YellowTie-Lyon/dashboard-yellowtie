import { formatLoad, formatPercent } from './format'
import type { AlertRule, CloudStatusRow, Metric, StatusReason } from './types'

export interface MetricMeta {
  key: Metric
  label: string
  unit: 'ratio' | 'percent' | 'load'
  help: string
}

/** Métriques évaluables, dans l'ordre d'affichage (les plus utiles d'abord). */
export const METRICS: MetricMeta[] = [
  { key: 'load1_per_core', label: 'Load 1 min par cœur', unit: 'ratio', help: '1,0 = tous les cœurs occupés en moyenne.' },
  { key: 'cpu_pct', label: 'CPU', unit: 'percent', help: "Part du temps processeur utilisée sur l'ensemble du Cloud." },
  { key: 'mem_used_pct', label: 'RAM utilisée', unit: 'percent', help: 'RAM totale moins la RAM disponible.' },
  { key: 'disk_used_pct', label: 'Disque utilisé', unit: 'percent', help: 'Volume partagé par les hébergements du Cloud.' },
  { key: 'swap_used_pct', label: 'Swap utilisé', unit: 'percent', help: 'Un swap qui grossit signale une pression mémoire.' },
  { key: 'load5_per_core', label: 'Load 5 min par cœur', unit: 'ratio', help: 'Charge lissée sur 5 minutes.' },
  { key: 'load1', label: 'Load 1 min (absolu)', unit: 'load', help: 'Sans division par le nombre de cœurs.' },
  { key: 'load5', label: 'Load 5 min (absolu)', unit: 'load', help: 'Sans division par le nombre de cœurs.' },
]

export function metricMeta(metric: Metric): MetricMeta {
  return METRICS.find((m) => m.key === metric) ?? METRICS[0]!
}

export function formatMetric(metric: Metric, value: number | null | undefined): string {
  return metricMeta(metric).unit === 'percent' ? formatPercent(value) : formatLoad(value)
}

/** Règle effective d'un Cloud : sa surcharge si elle existe, sinon la valeur par défaut du workspace. */
export function effectiveRule(
  rules: AlertRule[],
  metric: Metric,
  cloudId: string | null,
): { rule: AlertRule | undefined; source: 'cloud' | 'default' } {
  const override = cloudId ? rules.find((r) => r.metric === metric && r.cloud_server_id === cloudId) : undefined
  if (override) return { rule: override, source: 'cloud' }
  return { rule: rules.find((r) => r.metric === metric && r.cloud_server_id === null), source: 'default' }
}

export interface RuleInput {
  warn_threshold: number
  crit_threshold: number
  window_minutes: number
  min_breach_ratio: number
  recover_margin: number
  recover_minutes: number
  enabled: boolean
}

/** Miroir des contraintes SQL, pour signaler l'erreur avant l'envoi. Renvoie null si tout est valide. */
export function validateRule(r: RuleInput): string | null {
  const nums = [r.warn_threshold, r.crit_threshold, r.window_minutes, r.min_breach_ratio, r.recover_margin, r.recover_minutes]
  if (nums.some((n) => !Number.isFinite(n))) return 'Renseignez toutes les valeurs (nombres).'
  if (r.warn_threshold < 0) return 'Le seuil Warning doit être positif.'
  if (r.crit_threshold <= r.warn_threshold) return 'Le seuil Critical doit être strictement supérieur au seuil Warning.'
  if (!Number.isInteger(r.window_minutes) || r.window_minutes < 1 || r.window_minutes > 60) return 'La fenêtre doit être un nombre entier de minutes entre 1 et 60.'
  if (r.min_breach_ratio < 0.1 || r.min_breach_ratio > 1) return 'La part de relevés au-dessus du seuil doit être comprise entre 10 % et 100 %.'
  if (r.recover_margin < 0) return 'La marge de récupération ne peut pas être négative.'
  if (r.recover_margin >= r.warn_threshold && r.warn_threshold > 0) return 'La marge de récupération doit rester inférieure au seuil Warning.'
  if (!Number.isInteger(r.recover_minutes) || r.recover_minutes < 1 || r.recover_minutes > 120) return 'La durée de retour stable doit être un nombre entier de minutes entre 1 et 120.'
  return null
}

/** « Load 1 min par cœur : 1,12 (Warning dès 0,6, Critical dès 1,0) » */
export function reasonText(reason: StatusReason): string {
  const m = metricMeta(reason.metric)
  return `${m.label} : ${formatMetric(reason.metric, reason.value)} (Warning dès ${formatMetric(reason.metric, reason.warn)}, Critical dès ${formatMetric(reason.metric, reason.crit)})`
}

/** Version courte pour une carte : « Load 1 min par cœur 1,12 ». */
export function reasonShort(reason: StatusReason): string {
  return `${metricMeta(reason.metric).label} ${formatMetric(reason.metric, reason.value)}`
}

export type AgentHealth = 'ok' | 'delayed' | 'silent' | 'never'

/** Santé d'un agent d'après son dernier heartbeat (affichage ; le statut officiel du Cloud est calculé côté serveur). */
export function agentHealth(lastSeen: string | null | undefined, offlineAfterSeconds: number, now: number): AgentHealth {
  if (!lastSeen) return 'never'
  const age = (now - new Date(lastSeen).getTime()) / 1000
  if (age > offlineAfterSeconds) return 'silent'
  if (age > 90) return 'delayed'
  return 'ok'
}

/** Une ligne pour la carte d'un Cloud : pourquoi il n'est pas « Normal ». Null quand il n'y a rien à dire. */
export function statusSummary(row: CloudStatusRow | undefined): string | null {
  if (!row) return null
  const { status, detail } = row
  if (status === 'warning' || status === 'critical') {
    const [first, ...others] = detail.reasons
    if (!first) return null
    return `${reasonShort(first)}${others.length > 0 ? ` (+${others.length})` : ''}`
  }
  if (status === 'offline') {
    if (detail.offline_diagnosis === 'agents_silent') return 'Agents silencieux, les sondes répondent'
    if (detail.offline_diagnosis === 'unreachable_probable') return 'Aucun agent ne répond, sondes en échec'
    return 'Aucun agent ne répond'
  }
  if (status === 'unknown') {
    if (detail.connectivity === 'metrics_stale') return 'Collecteur système silencieux'
    if (detail.connectivity === 'never') return 'Aucun agent installé'
  }
  if (status === 'maintenance') return 'Alertes suspendues'
  return null
}
