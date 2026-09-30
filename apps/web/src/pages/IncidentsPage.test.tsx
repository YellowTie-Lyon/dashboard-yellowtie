import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentWithNames } from '../lib/types'
import { IncidentsPage } from './IncidentsPage'

const fetchIncidents = vi.fn<() => Promise<IncidentWithNames[]>>()
vi.mock('../features/incidents/api', () => ({ fetchIncidents: () => fetchIncidents() }))

function incident(over: Partial<IncidentWithNames>): IncidentWithNames {
  return {
    id: 'i1',
    workspace_id: 'w1',
    cloud_server_id: 'c1',
    web_hosting_id: null,
    kind: 'performance',
    status: 'critical',
    severity_max: 'critical',
    started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    ended_at: null,
    recovery_since: null,
    reasons: [],
    peak: {},
    start_snapshot: {},
    diagnosis: null,
    note: null,
    cloud_servers: { name: 'Cloud 1' },
    web_hostings: null,
    ...over,
  } as IncidentWithNames
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IncidentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('IncidentsPage', () => {
  beforeEach(() => fetchIncidents.mockReset())

  it('affiche un message vide quand aucun incident', async () => {
    fetchIncidents.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/Aucun incident enregistré/)).toBeInTheDocument()
  })

  it('liste les incidents et filtre les clos', async () => {
    fetchIncidents.mockResolvedValue([
      incident({ id: 'a', status: 'critical' }),
      incident({ id: 'b', kind: 'disk', status: 'closed', ended_at: new Date().toISOString() }),
    ])
    renderPage()
    expect(await screen.findByText(/1 en cours/)).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
    await userEvent.selectOptions(screen.getByLabelText('État'), 'open')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})
