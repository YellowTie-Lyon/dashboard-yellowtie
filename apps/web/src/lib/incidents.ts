import type { IncidentBand } from '../features/metrics/SeriesChart'
import { formatDuration } from './format'
import { reasonShort } from './alerts'
import type { Incident, IncidentEvent, IncidentKind, IncidentStatus, StatusReason } from './types'

/** Vocabulaire des incidents. Formulations prudentes : un incident décrit un état observé, jamais une cause établie. */
export const KIND_LABELS: Record<IncidentKind, string> = {
  performance: 'Performance',
  disk: 'Disque',
  offline: 'Offline',
  agent: 'Agent silencieux',
}

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  warning: 'Warning',
  critical: 'Critical',
  recovery: 'Retour à la normale',
  closed: 'Clos',
}

export const isOpen = (i: Pick<Incident, 'status'>): boolean => i.status !== 'closed'

/** Fin de la période d'incident : début du retour stable si clos ou en retour, sinon maintenant. */
export function incidentEnd(i: Pick<Incident, 'ended_at' | 'recovery_since'>, nowMs: number): number {
  const end = i.ended_at ?? i.recovery_since
  return end ? new Date(end).getTime() : nowMs
}

export function incidentDurationMs(i: Pick<Incident, 'started_at' | 'ended_at' | 'recovery_since'>, nowMs: number): number {
  return Math.max(0, incidentEnd(i, nowMs) - new Date(i.started_at).getTime())
}

export function formatIncidentDuration(i: Pick<Incident, 'started_at' | 'ended_at' | 'recovery_since'>, nowMs: number): string {
  return formatDuration(incidentDurationMs(i, nowMs) / 1000)
}

export function bandFor(i: Pick<Incident, 'started_at' | 'ended_at' | 'recovery_since' | 'severity_max'>, nowMs: number): IncidentBand {
  return { from: new Date(i.started_at).getTime(), to: incidentEnd(i, nowMs), level: i.severity_max }
}

const DIAGNOSIS_SHORT = {
  agents_silent: 'Agents silencieux, les sondes répondent',
  unreachable_probable: 'Aucun agent ne répond, sondes en échec',
  unknown_cause: 'Aucun agent ne répond',
} as const

/** Une ligne de résumé pour la liste des incidents. */
export function incidentSummary(i: Pick<Incident, 'kind' | 'reasons' | 'diagnosis'>): string {
  if (i.kind === 'offline') return i.diagnosis ? DIAGNOSIS_SHORT[i.diagnosis] : 'Aucun agent ne répond'
  if (i.kind === 'agent') {
    const r = i.reasons[0]
    return r?.kind === 'metrics_stale' ? 'Collecteur actif mais sans relevé système' : 'Agent silencieux, les autres agents répondent'
  }
  const first = i.reasons[0] as StatusReason | undefined
  if (!first?.metric) return '—'
  return `${reasonShort(first)}${i.reasons.length > 1 ? ` (+${i.reasons.length - 1})` : ''}`
}

/** Ligne de la chronologie. */
export function eventText(e: IncidentEvent): string {
  const level = (v: string | undefined) => (v === 'critical' ? 'Critical' : v === 'warning' ? 'Warning' : (v ?? '?'))
  switch (e.type) {
    case 'opened':
      return `Ouverture en ${level(e.data.level)}`
    case 'escalated':
      return `Escalade ${level(e.data.from)} → ${level(e.data.to)}`
    case 'deescalated':
      return `Désescalade ${level(e.data.from)} → ${level(e.data.to)}`
    case 'recovery_started':
      return 'Retour à la normale constaté, confirmation en cours'
    case 'relapse':
      return `Rechute : de nouveau ${level(e.data.level)}`
    case 'closed':
      return `Incident clos${e.data.duration_seconds != null ? ` (durée ${formatDuration(e.data.duration_seconds)})` : ''}`
  }
}
