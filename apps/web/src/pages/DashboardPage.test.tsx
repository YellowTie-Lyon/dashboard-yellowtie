import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudState, CloudStatusRow, CloudWithCounts, DomainTrafficRow } from '../lib/types'
import { DashboardPage } from './DashboardPage'

const fetchClouds = vi.fn<() => Promise<CloudWithCounts[]>>()
const fetchCloudStates = vi.fn<() => Promise<CloudState[]>>()
const fetchCloudStatuses = vi.fn<() => Promise<CloudStatusRow[]>>()
let canWrite = true
let hostingStates: import('../lib/types').HostingState[] = []

vi.mock('../features/inventory/api', async () => {
  const actual = await vi.importActual<typeof import('../features/inventory/api')>('../features/inventory/api')
  return { ...actual, fetchClouds: () => fetchClouds(), fetchCloudStates: () => fetchCloudStates(), fetchHostingStates: () => Promise.resolve(hostingStates) }
})
vi.mock('../features/alerts/api', async () => {
  const actual = await vi.importActual<typeof import('../features/alerts/api')>('../features/alerts/api')
  return { ...actual, fetchCloudStatuses: () => fetchCloudStatuses() }
})
vi.mock('../features/incidents/api', () => ({ fetchIncidents: () => Promise.resolve([]) }))
const fetchTopDomains = vi.fn<() => Promise<DomainTrafficRow[]>>()
vi.mock('../features/traffic/api', () => ({ fetchTopDomains: () => fetchTopDomains() }))
vi.mock('../features/metrics/api', () => ({ fetchSeries: () => Promise.resolve([]) }))
vi.mock('../features/workspace/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'w1', name: 'YellowTie', role: canWrite ? 'owner' : 'viewer' },
    isPending: false,
    error: null,
    canWrite,
  }),
}))

function cloud(over: Partial<CloudWithCounts>): CloudWithCounts {
  return {
    id: 'c1',
    workspace_id: 'w1',
    name: 'YellowTie Server Cloud 1',
    slug: 'cloud-1',
    provider: 'infomaniak',
    cpu_cores: 12,
    hostname: null,
    offline_after_seconds: 240,
    maintenance: false,
    notes: null,
    created_at: '2026-09-30T08:00:00Z',
    updated_at: '2026-09-30T08:00:00Z',
    web_hostings: [],
    ...over,
  }
}

function status(value: CloudStatusRow['status'], detail: Partial<CloudStatusRow['detail']> = {}, cloudId = 'c1'): CloudStatusRow {
  return {
    cloud_server_id: cloudId,
    status: value,
    status_since: new Date().toISOString(),
    evaluated_at: new Date().toISOString(),
    detail: { reasons: [], connectivity: 'ok', offline_diagnosis: null, last_agent_seen: null, metrics_received: null, ...detail },
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('DashboardPage', () => {
  beforeEach(() => {
    canWrite = true
    hostingStates = []
    fetchClouds.mockReset()
    fetchCloudStates.mockReset()
    fetchCloudStates.mockResolvedValue([])
    fetchCloudStatuses.mockReset()
    fetchCloudStatuses.mockResolvedValue([])
    fetchTopDomains.mockReset()
    fetchTopDomains.mockResolvedValue([])
  })

  it('affiche l’état vide quand aucun Cloud n’existe', async () => {
    fetchClouds.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('Aucun Server Cloud configuré')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ajouter un Server Cloud/ })).toBeInTheDocument()
  })

  it('affiche une carte par Cloud avec ses compteurs d’hébergements et de sites', async () => {
    fetchClouds.mockResolvedValue([
      cloud({
        web_hostings: [
          { id: 'h1', name: 'Hébergement h1', sites: [{ count: 9 }] },
          { id: 'h2', name: 'Hébergement h2', sites: [{ count: 24 }] },
          { id: 'h3', name: 'Hébergement h3', sites: [{ count: 29 }] },
        ],
      }),
      cloud({ id: 'c2', name: 'YellowTie Server Cloud 2', web_hostings: [{ id: 'h4', name: 'Hébergement h4', sites: [{ count: 1 }] }] }),
    ])
    renderPage()
    expect(await screen.findByText('YellowTie Server Cloud 1')).toBeInTheDocument()
    expect(screen.getByText(/2 Server Clouds · 4 hébergements · 63 sites/)).toBeInTheDocument()
    expect(screen.getAllByText('Aucune donnée')).toHaveLength(2)
  })

  it('masque le bouton d’ajout pour un simple lecteur', async () => {
    canWrite = false
    fetchClouds.mockResolvedValue([])
    renderPage()
    await screen.findByText('Aucun Server Cloud configuré')
    expect(screen.queryByRole('button', { name: /Ajouter un Server Cloud/ })).not.toBeInTheDocument()
  })

  it('affiche les valeurs du dernier relevé et le statut calculé', async () => {
    fetchClouds.mockResolvedValue([cloud({ web_hostings: [{ id: 'h1', name: 'Hébergement h1', sites: [{ count: 3 }] }] })])
    const nowIso = new Date().toISOString()
    fetchCloudStates.mockResolvedValue([
      {
        cloud_server_id: 'c1',
        last_metrics_at: nowIso,
        last_received_at: nowIso,
        last_point: {
          ts: Math.floor(Date.now() / 1000),
          cpu_cores: 12,
          load1: 2.43,
          load5: 3.13,
          load15: 4.12,
          load1_per_core: 0.203,
          cpu_pct: 15.1,
          mem_total_mb: 36093,
          mem_used_mb: 11937,
          mem_avail_mb: 24156,
          mem_used_pct: 33.1,
          swap_total_mb: 4095,
          swap_used_mb: 0,
          swap_used_pct: 0,
          disk_total_mb: 281589,
          disk_used_mb: 141757,
          disk_avail_mb: 139843,
          disk_used_pct: 50.3,
          uptime_s: 1234567,
        },
      },
    ])
    fetchCloudStatuses.mockResolvedValue([status('normal')])
    renderPage()
    expect(await screen.findByText('Normal')).toBeInTheDocument()
    expect(screen.getByText('15,1 %')).toBeInTheDocument()
    expect(screen.getByText('2,43')).toBeInTheDocument()
    expect(screen.getByText('33,1 %')).toBeInTheDocument()
    expect(screen.getByText('50,3 %')).toBeInTheDocument()
    expect(screen.getByText(/à l'instant/)).toBeInTheDocument()
  })

  it('affiche un Warning avec sa raison principale', async () => {
    fetchClouds.mockResolvedValue([cloud({})])
    fetchCloudStatuses.mockResolvedValue([
      status('warning', {
        reasons: [{ metric: 'cpu_pct', level: 'warning', value: 82, warn: 75, crit: 90, since: new Date().toISOString() }],
      }),
    ])
    renderPage()
    expect((await screen.findAllByText('Warning')).length).toBeGreaterThan(0)
    expect(screen.getByText('CPU 82 %')).toBeInTheDocument()
  })

  it('affiche un Cloud hors ligne avec un diagnostic prudent', async () => {
    fetchClouds.mockResolvedValue([cloud({})])
    fetchCloudStatuses.mockResolvedValue([status('offline', { connectivity: 'silent', offline_diagnosis: 'agents_silent' })])
    renderPage()
    expect(await screen.findByText('Offline')).toBeInTheDocument()
    expect(screen.getByText('Agents silencieux, les sondes répondent')).toBeInTheDocument()
    expect(screen.queryByText(/mort|arrêté/i)).not.toBeInTheDocument()
  })

  it('affiche le statut de chaque Cloud séparément', async () => {
    fetchClouds.mockResolvedValue([cloud({}), cloud({ id: 'c2', name: 'YellowTie Server Cloud 2' })])
    fetchCloudStatuses.mockResolvedValue([status('critical', {
      reasons: [{ metric: 'load1_per_core', level: 'critical', value: 1.4, warn: 0.6, crit: 1, since: new Date().toISOString() }],
    }, 'c2'), status('normal', {}, 'c1')])
    renderPage()
    expect((await screen.findAllByText('Critical')).length).toBeGreaterThan(0)
    expect(screen.getByText('Normal')).toBeInTheDocument()
  })

  it('liste les hébergements de chaque Cloud avec un lien vers leur page', async () => {
    fetchClouds.mockResolvedValue([cloud({ web_hostings: [{ id: 'h1', name: 'Hébergement 1', sites: [{ count: 3 }] }] })])
    renderPage()
    expect(await screen.findByRole('link', { name: /Hébergement 1/ })).toHaveAttribute('href', '/hostings/h1')
    expect(screen.getByText(/agent non installé/)).toBeInTheDocument()
  })

  it('résume la situation en une phrase : tout est normal', async () => {
    fetchClouds.mockResolvedValue([cloud({})])
    fetchCloudStatuses.mockResolvedValue([status('normal')])
    renderPage()
    expect(await screen.findByText('Tout est normal')).toBeInTheDocument()
  })

  it('nomme le Cloud et le motif dans le bandeau quand il y a un problème', async () => {
    fetchClouds.mockResolvedValue([cloud({}), cloud({ id: 'c2', name: 'YellowTie Server Cloud 2' })])
    fetchCloudStatuses.mockResolvedValue([
      status('normal', {}, 'c1'),
      status('critical', { reasons: [{ metric: 'cpu_pct', level: 'critical', value: 92, warn: 75, crit: 90, since: new Date().toISOString() }] }, 'c2'),
    ])
    renderPage()
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('YellowTie Server Cloud 2')
    expect(banner).toHaveTextContent('CPU 92 %')
    expect(screen.queryByText('Tout est normal')).not.toBeInTheDocument()
  })

  it('classe les hébergements par trafic et liste les domaines les plus sollicités', async () => {
    fetchClouds.mockResolvedValue([
      cloud({ web_hostings: [{ id: 'h1', name: 'Hébergement 1', sites: [{ count: 3 }] }, { id: 'h2', name: 'Hébergement 2', sites: [{ count: 3 }] }] }),
    ])
    const row = (domain: string, hosting: string, name: string, requests: number, share: number): DomainTrafficRow => ({
      domain, web_hosting_id: hosting, hosting_name: name, requests, bytes: 0, r4xx: 0, r5xx: 0, posts: 0, bots: 0, share,
    })
    fetchTopDomains.mockResolvedValue([row('gros-trafic.fr', 'h2', 'Hébergement 2', 900, 90), row('petit.fr', 'h1', 'Hébergement 1', 100, 10)])
    renderPage()
    const domain = await screen.findByRole('link', { name: /gros-trafic\.fr/ })
    expect(domain).toHaveAttribute('href', '/hostings/h2?domain=gros-trafic.fr')
    const hostingLinks = screen.getAllByRole('link', { name: /^Hébergement \d/ }).map((a) => a.textContent)
    expect(hostingLinks[0]).toContain('Hébergement 2')
    expect(screen.queryByText(/Pas encore de trafic analysé/)).not.toBeInTheDocument()
  })

  it('explique l\'absence de trafic avant l\'installation de l\'agent 0.3.0', async () => {
    fetchClouds.mockResolvedValue([cloud({})])
    renderPage()
    expect(await screen.findByText(/Pas encore de trafic analysé/)).toBeInTheDocument()
  })

  it('le classement suit la charge du moment : 15 minutes par défaut, 1 h au choix', async () => {
    fetchClouds.mockResolvedValue([cloud({})])
    renderPage()
    expect(await screen.findByText(/Hébergements · les 15 dernières minutes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '1 h' }))
    expect(await screen.findByText(/Hébergements · la dernière heure/)).toBeInTheDocument()
  })

  it("affiche la version de l'agent à côté du nom de l'hébergement, en orange si elle est ancienne", async () => {
    const base = { last_seen_at: new Date().toISOString(), hostname_seen: null, backlog: 0, last_error: null, log_size_bytes: null, log_inode: null, anomaly: null }
    hostingStates = [
      { ...base, web_hosting_id: 'h1', agent_version: '0.4.0' },
      { ...base, web_hosting_id: 'h2', agent_version: '0.2.0' },
    ]
    fetchClouds.mockResolvedValue([
      cloud({ web_hostings: [{ id: 'h1', name: 'Hébergement 1', sites: [{ count: 1 }] }, { id: 'h2', name: 'Hébergement 2', sites: [{ count: 1 }] }] }),
    ])
    renderPage()
    expect(await screen.findByText('v0.4.0')).toHaveClass('text-slate-500')
    expect(screen.getByText('v0.2.0')).toHaveClass('text-orange-400')
  })
})
