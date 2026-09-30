import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudServer, JobState, SeriesPoint, SeriesRange } from '../../lib/types'
import { MetricsCharts } from './MetricsCharts'

const fetchSeries = vi.fn<(cloudId: string, range: SeriesRange) => Promise<SeriesPoint[]>>()
const fetchJobStates = vi.fn<() => Promise<JobState[]>>()

vi.mock('./api', () => ({
  fetchSeries: (cloudId: string, range: SeriesRange) => fetchSeries(cloudId, range),
  fetchJobStates: () => fetchJobStates(),
}))

const cloud: CloudServer = {
  id: 'c1', workspace_id: 'w1', name: 'Cloud 1', slug: 'cloud-1', provider: 'infomaniak', cpu_cores: 12, hostname: null,
  offline_after_seconds: 240, maintenance: false, notes: null, created_at: '2026-09-30T08:00:00Z', updated_at: '2026-09-30T08:00:00Z',
}

function points(count: number): SeriesPoint[] {
  const start = Date.now() - count * 5 * 60_000
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(start + i * 5 * 60_000).toISOString(), n: 5,
    load1_avg: 2.5, load1_max: 4.1, load5_avg: 3.1, load15_avg: 4.2, cpu_pct_avg: 15, cpu_pct_max: 30,
    mem_used_pct_avg: 32, mem_used_pct_max: 33, swap_used_pct_avg: 11.6, swap_used_pct_max: 12,
    disk_used_pct_avg: 50.4, disk_used_pct_max: 50.4,
  }))
}

function renderCharts() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MetricsCharts cloud={cloud} />
    </QueryClientProvider>,
  )
}

describe('MetricsCharts', () => {
  beforeEach(() => {
    fetchSeries.mockReset()
    fetchJobStates.mockReset()
    fetchSeries.mockResolvedValue(points(20))
    fetchJobStates.mockResolvedValue([{ name: 'rollup', last_run_at: new Date().toISOString(), detail: {} }])
  })

  it('propose les 5 périodes, 24 h sélectionnée par défaut', async () => {
    renderCharts()
    const group = screen.getByRole('group', { name: 'Période' })
    expect(group.querySelectorAll('button')).toHaveLength(5)
    expect(screen.getByRole('button', { name: '24 h' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(fetchSeries).toHaveBeenCalledWith('c1', '24h'))
  })

  it('recharge toutes les courbes quand on change de période', async () => {
    renderCharts()
    await screen.findByText('Load average')
    await userEvent.click(screen.getByRole('button', { name: '7 j' }))
    await waitFor(() => expect(fetchSeries).toHaveBeenCalledWith('c1', '7d'))
    expect(screen.getByRole('button', { name: '7 j' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('affiche les quatre graphiques avec leurs valeurs actuelles', async () => {
    renderCharts()
    expect(await screen.findByText('Load average')).toBeInTheDocument()
    for (const title of ['CPU', 'Mémoire', 'Disque']) expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.getByText('2,50')).toBeInTheDocument()
    expect(screen.getByText('50,4 %')).toBeInTheDocument()
    expect(screen.getByText(/swap 11,6 %/)).toBeInTheDocument()
  })

  it('met une légende sur les graphiques à plusieurs séries et mentionne le pic sur les tranches', async () => {
    renderCharts()
    await screen.findByText('Load average')
    expect(screen.getAllByText('Load 5 min').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Swap').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Pic de la tranche').length).toBeGreaterThan(0)
  })

  it('n’affiche pas de « pic » sur les relevés bruts (1 h)', async () => {
    renderCharts()
    await screen.findByText('Load average')
    await userEvent.click(screen.getByRole('button', { name: '1 h' }))
    await waitFor(() => expect(fetchSeries).toHaveBeenCalledWith('c1', '1h'))
    await waitFor(() => expect(screen.queryByText('Pic de la tranche')).not.toBeInTheDocument())
  })

  it('indique l’absence de relevé', async () => {
    fetchSeries.mockResolvedValue([])
    renderCharts()
    expect(await screen.findByText('Aucun relevé sur cette période.')).toBeInTheDocument()
  })

  it('offre un tableau de valeurs équivalent aux courbes', async () => {
    renderCharts()
    await screen.findByText('Load average')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Voir les valeurs sous forme de tableau'))
    const table = await screen.findByRole('table')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(20)
  })

  it('signale un planificateur d’agrégation inactif', async () => {
    fetchJobStates.mockResolvedValue([{ name: 'rollup', last_run_at: new Date(Date.now() - 3 * 3600_000).toISOString(), detail: {} }])
    renderCharts()
    expect(await screen.findByText(/n'a pas tourné récemment/)).toBeInTheDocument()
  })

  it('confirme l’agrégation quand elle tourne', async () => {
    renderCharts()
    expect(await screen.findByText(/Agrégation horaire : dernière exécution/)).toBeInTheDocument()
  })
})
