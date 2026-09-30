import { describe, expect, it } from 'vitest'
import { bandFor, eventText, formatIncidentDuration, incidentDurationMs, incidentSummary, isOpen } from './incidents'
import type { Incident, IncidentEvent } from './types'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const base = { started_at: '2026-09-30T10:00:00Z', ended_at: null, recovery_since: null, severity_max: 'warning' } as const

function incident(over: Partial<Incident>): Incident {
  return {
    id: 'i', workspace_id: 'w', cloud_server_id: 'c', web_hosting_id: null, kind: 'performance', status: 'warning', reasons: [],
    peak: {}, start_snapshot: null, diagnosis: null, note: null, ...base, ...over,
  }
}

describe('durée et fin d’un incident', () => {
  it('un incident en cours dure jusqu’à maintenant', () => {
    expect(incidentDurationMs(incident({}), NOW)).toBe(2 * 3_600_000)
    expect(formatIncidentDuration(incident({}), NOW)).toBe('2 h 00')
  })

  it('un incident en retour s’arrête au début du retour stable', () => {
    const i = incident({ status: 'recovery', recovery_since: '2026-09-30T10:17:00Z' })
    expect(formatIncidentDuration(i, NOW)).toBe('17 min')
  })

  it('un incident clos s’arrête à sa fin, pas à la confirmation', () => {
    const i = incident({ status: 'closed', ended_at: '2026-09-30T10:45:00Z', recovery_since: '2026-09-30T10:45:00Z' })
    expect(formatIncidentDuration(i, NOW)).toBe('45 min')
    expect(isOpen(i)).toBe(false)
    expect(isOpen(incident({}))).toBe(true)
  })

  it('fournit la zone à tracer sur les graphiques', () => {
    const band = bandFor(incident({ severity_max: 'critical', status: 'closed', ended_at: '2026-09-30T10:30:00Z' }), NOW)
    expect(band).toEqual({ from: Date.parse('2026-09-30T10:00:00Z'), to: Date.parse('2026-09-30T10:30:00Z'), level: 'critical' })
    expect(bandFor(incident({}), NOW).to).toBe(NOW)
  })
})

describe('incidentSummary', () => {
  it('résume la première raison d’un incident de performance', () => {
    const i = incident({ reasons: [
      { metric: 'cpu_pct', level: 'critical', value: 93, warn: 75, crit: 90, since: '' },
      { metric: 'mem_used_pct', level: 'warning', value: 88, warn: 85, crit: 95, since: '' },
    ] })
    expect(incidentSummary(i)).toBe('CPU 93 % (+1)')
  })

  it('reste prudent pour un incident offline', () => {
    expect(incidentSummary(incident({ kind: 'offline', diagnosis: 'unreachable_probable' }))).toBe('Aucun agent ne répond, sondes en échec')
    expect(incidentSummary(incident({ kind: 'offline', diagnosis: null }))).toBe('Aucun agent ne répond')
  })

  it('distingue agent silencieux et collecteur sans relevé', () => {
    expect(incidentSummary(incident({ kind: 'agent', reasons: [{ kind: 'silent' }] }))).toMatch(/silencieux/)
    expect(incidentSummary(incident({ kind: 'agent', reasons: [{ kind: 'metrics_stale' }] }))).toMatch(/sans relevé/)
  })
})

describe('eventText', () => {
  const ev = (type: IncidentEvent['type'], data: IncidentEvent['data'] = {}): IncidentEvent => ({ id: 1, incident_id: 'i', ts: '', type, data })

  it.each([
    [ev('opened', { level: 'warning' }), 'Ouverture en Warning'],
    [ev('escalated', { from: 'warning', to: 'critical' }), 'Escalade Warning → Critical'],
    [ev('deescalated', { from: 'critical', to: 'warning' }), 'Désescalade Critical → Warning'],
    [ev('recovery_started'), 'Retour à la normale constaté, confirmation en cours'],
    [ev('relapse', { level: 'critical' }), 'Rechute : de nouveau Critical'],
    [ev('closed', { duration_seconds: 1020 }), 'Incident clos (durée 17 min)'],
  ])('%j', (event, expected) => {
    expect(eventText(event)).toBe(expected)
  })
})
