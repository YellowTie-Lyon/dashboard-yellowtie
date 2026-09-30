import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CloudStatusRow } from '../lib/types'
import { StatusCard } from './StatusCard'

function row(status: CloudStatusRow['status'], detail: Partial<CloudStatusRow['detail']> = {}): CloudStatusRow {
  return {
    cloud_server_id: 'c1', status, status_since: new Date(Date.now() - 12 * 60_000).toISOString(), evaluated_at: new Date().toISOString(),
    detail: { reasons: [], connectivity: 'ok', offline_diagnosis: null, last_agent_seen: null, metrics_received: null, ...detail },
  }
}

describe('StatusCard', () => {
  it('liste les raisons d’un Critical avec les seuils', () => {
    render(<StatusCard now={Date.now()} row={row('critical', {
      reasons: [{ metric: 'load1_per_core', level: 'critical', value: 1.12, warn: 0.6, crit: 1, since: new Date(Date.now() - 12 * 60_000).toISOString() }],
    })} />)
    expect(screen.getByText('Critical')).toBeInTheDocument()
    expect(screen.getByText(/Load 1 min par cœur : 1,12 \(Warning dès 0,60, Critical dès 1,00\)/)).toBeInTheDocument()
    expect(screen.getByText(/depuis 12 min/, { selector: 'span span' })).toBeInTheDocument()
  })

  it.each([
    ['agents_silent', /agent ou cron probablement arrêté/],
    ['unreachable_probable', /potentiellement inaccessible/],
    ['unknown_cause', /Cause indéterminée/],
  ] as const)('diagnostic %s : formulation prudente', (diag, expected) => {
    render(<StatusCard now={Date.now()} row={row('offline', { connectivity: 'silent', offline_diagnosis: diag })} />)
    expect(screen.getByText(expected)).toBeInTheDocument()
    expect(screen.queryByText(/serveur (est )?mort/i)).not.toBeInTheDocument()
  })

  it('explique un collecteur silencieux', () => {
    render(<StatusCard now={Date.now()} row={row('unknown', { connectivity: 'metrics_stale' })} />)
    expect(screen.getByText(/collecteur système est silencieux/)).toBeInTheDocument()
  })

  it('confirme un statut Normal et signale un retard', () => {
    render(<StatusCard now={Date.now()} row={row('normal', { connectivity: 'delayed' })} />)
    expect(screen.getByText(/dans leurs limites/)).toBeInTheDocument()
    expect(screen.getByText(/Données en retard/)).toBeInTheDocument()
  })

  it('explique la maintenance', () => {
    render(<StatusCard now={Date.now()} row={row('maintenance')} />)
    expect(screen.getByText(/aucune alerte n'est évaluée/)).toBeInTheDocument()
  })

  it('reste sobre avant la première évaluation', () => {
    render(<StatusCard now={Date.now()} row={undefined} />)
    expect(screen.getByText(/Pas encore évalué/)).toBeInTheDocument()
  })
})
