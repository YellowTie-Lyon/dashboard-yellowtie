import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobState } from '../../lib/types'
import { SystemAlert } from './SystemAlert'
import { SystemHealth } from './SystemHealth'
import type { StorageStats } from './api'

const fetchJobStates = vi.fn<() => Promise<JobState[]>>()
const fetchStorageStats = vi.fn<() => Promise<StorageStats | null>>()
vi.mock('../metrics/api', () => ({ fetchJobStates: () => fetchJobStates() }))
vi.mock('./api', () => ({ fetchStorageStats: () => fetchStorageStats() }))

const MB = 1024 * 1024
const recent = (name: string): JobState => ({ name, last_run_at: new Date().toISOString(), detail: {} })
const healthyJobs = ['evaluate', 'rollup', 'traffic', 'probes', 'purge', 'traffic_purge'].map(recent)

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SystemAlert', () => {
  beforeEach(() => {
    fetchJobStates.mockReset()
    fetchStorageStats.mockReset()
  })

  it("n'affiche rien quand tout va bien", async () => {
    fetchJobStates.mockResolvedValue(healthyJobs)
    fetchStorageStats.mockResolvedValue({ db_bytes: 50 * MB, tables: [] })
    wrap(<SystemAlert />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it("signale une tâche essentielle qui ne s'est jamais exécutée", async () => {
    fetchJobStates.mockResolvedValue([])
    fetchStorageStats.mockResolvedValue({ db_bytes: 50 * MB, tables: [] })
    wrap(<SystemAlert />)
    expect(await screen.findByRole('link', { name: /à vérifier/ })).toHaveAttribute('href', '/reglages')
  })

  it('signale un stockage proche du quota', async () => {
    fetchJobStates.mockResolvedValue(healthyJobs)
    fetchStorageStats.mockResolvedValue({ db_bytes: 460 * MB, tables: [] })
    wrap(<SystemAlert />)
    expect(await screen.findByRole('link', { name: /1 point à vérifier/ })).toBeInTheDocument()
  })
})

describe('SystemHealth', () => {
  beforeEach(() => {
    fetchJobStates.mockReset()
    fetchStorageStats.mockReset()
  })

  it('liste les tâches et le stockage avec les plus grosses tables', async () => {
    fetchJobStates.mockResolvedValue(healthyJobs)
    fetchStorageStats.mockResolvedValue({ db_bytes: 100 * MB, tables: [{ name: 'metrics', bytes: 60 * MB, rows: 900000 }] })
    wrap(<SystemHealth />)
    expect(await screen.findByText('metrics')).toBeInTheDocument()
    expect(screen.getByText('Évaluation des statuts')).toBeInTheDocument()
    expect(screen.getAllByText('En marche')).toHaveLength(6)
    expect(screen.getByRole('progressbar', { name: 'Stockage utilisé' })).toHaveAttribute('aria-valuenow', '20')
  })

  it('avertit à partir de 70 % du quota', async () => {
    fetchJobStates.mockResolvedValue(healthyJobs)
    fetchStorageStats.mockResolvedValue({ db_bytes: 400 * MB, tables: [] })
    wrap(<SystemHealth />)
    expect(await screen.findByText(/Plus de 70 %/)).toBeInTheDocument()
  })
})
