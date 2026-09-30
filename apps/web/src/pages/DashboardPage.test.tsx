import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudWithCounts } from '../lib/types'
import { DashboardPage } from './DashboardPage'

const fetchClouds = vi.fn<() => Promise<CloudWithCounts[]>>()
let canWrite = true

vi.mock('../features/inventory/api', async () => {
  const actual = await vi.importActual<typeof import('../features/inventory/api')>('../features/inventory/api')
  return { ...actual, fetchClouds: () => fetchClouds() }
})
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
    fetchClouds.mockReset()
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
          { id: 'h1', sites: [{ count: 9 }] },
          { id: 'h2', sites: [{ count: 24 }] },
          { id: 'h3', sites: [{ count: 29 }] },
        ],
      }),
      cloud({ id: 'c2', name: 'YellowTie Server Cloud 2', web_hostings: [{ id: 'h4', sites: [{ count: 1 }] }] }),
    ])
    renderPage()
    expect(await screen.findByText('YellowTie Server Cloud 1')).toBeInTheDocument()
    expect(screen.getByText(/3 hébergements · 62 sites · 12 vCPU/)).toBeInTheDocument()
    expect(screen.getByText(/1 hébergement · 1 site/)).toBeInTheDocument()
    expect(screen.getAllByText('Aucune donnée')).toHaveLength(2)
  })

  it('masque le bouton d’ajout pour un simple lecteur', async () => {
    canWrite = false
    fetchClouds.mockResolvedValue([])
    renderPage()
    await screen.findByText('Aucun Server Cloud configuré')
    expect(screen.queryByRole('button', { name: /Ajouter un Server Cloud/ })).not.toBeInTheDocument()
  })
})
