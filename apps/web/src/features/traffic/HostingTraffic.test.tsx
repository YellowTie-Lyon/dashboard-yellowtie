import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostingTraffic as Data } from '../../lib/types'
import { HostingTraffic } from './HostingTraffic'

const fetchHostingTraffic = vi.fn<(id: string, minutes: number) => Promise<Data | null>>()
vi.mock('./api', () => ({ fetchHostingTraffic: (id: string, m: number) => fetchHostingTraffic(id, m) }))

const data = (over: Partial<Data> = {}): Data => ({
  minutes: 60,
  totals: { requests: 1000, bytes: 5_000_000, r2xx: 800, r3xx: 50, r4xx: 100, r5xx: 50, posts: 200, bots: 300 },
  sampled: false,
  last_at: new Date().toISOString(),
  domains: [
    { domain: 'gros.fr', requests: 800, bytes: 1, r4xx: 0, r5xx: 50, posts: 0, bots: 0 },
    { domain: 'petit.fr', requests: 200, bytes: 1, r4xx: 0, r5xx: 0, posts: 0, bots: 0 },
  ],
  series: [],
  paths: [
    { domain: 'gros.fr', path: '/wp-login.php', requests: 500, errors: 40 },
    { domain: 'petit.fr', path: '/', requests: 100, errors: 0 },
  ],
  ips: [{ ip: '203.0.113.9', requests: 400 }],
  agents: { googlebot: 100, bots: 200, browsers: 690, empty: 10 },
  ...over,
})

function renderIt(focus: string | null = null, onFocus = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <HostingTraffic hostingId="h1" focusDomain={focus} onFocus={onFocus} />
    </QueryClientProvider>,
  )
  return onFocus
}

describe('HostingTraffic', () => {
  beforeEach(() => fetchHostingTraffic.mockReset())

  it("explique l'absence de données avant l'agent 0.3.0", async () => {
    fetchHostingTraffic.mockResolvedValue(data({ totals: { requests: 0, bytes: 0, r2xx: 0, r3xx: 0, r4xx: 0, r5xx: 0, posts: 0, bots: 0 }, last_at: null, domains: [] }))
    renderIt()
    expect(await screen.findByText(/Aucun trafic analysé/)).toBeInTheDocument()
    expect(screen.getByText(/agent 0\.3\.1/)).toBeInTheDocument()
  })

  it('affiche domaines, URL, IP et visiteurs', async () => {
    fetchHostingTraffic.mockResolvedValue(data())
    renderIt()
    expect(await screen.findByRole('button', { name: /gros\.fr/ })).toBeInTheDocument()
    expect(screen.getByText('/wp-login.php')).toBeInTheDocument()
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument()
    expect(screen.getByText('Googlebot')).toBeInTheDocument()
    expect(screen.getByText(/potentiellement impliqués/)).toBeInTheDocument()
  })

  it('cliquer un domaine filtre les URL', async () => {
    fetchHostingTraffic.mockResolvedValue(data())
    const onFocus = renderIt()
    await userEvent.click(await screen.findByRole('button', { name: /gros\.fr/ }))
    expect(onFocus).toHaveBeenCalledWith('gros.fr')
  })

  it('filtre les URL sur le domaine choisi', async () => {
    fetchHostingTraffic.mockResolvedValue(data())
    renderIt('petit.fr')
    await screen.findByText('petit.fr ✕')
    expect(screen.queryByText('/wp-login.php')).not.toBeInTheDocument()
  })

  it('change de période', async () => {
    fetchHostingTraffic.mockResolvedValue(data())
    renderIt()
    await screen.findByRole('button', { name: /gros\.fr/ })
    await userEvent.click(screen.getByRole('button', { name: '24 h' }))
    expect(fetchHostingTraffic).toHaveBeenLastCalledWith('h1', 1440)
  })

  it("signale un échantillon quand le log était trop volumineux", async () => {
    fetchHostingTraffic.mockResolvedValue(data({ sampled: true }))
    renderIt()
    expect(await screen.findByText(/Log très volumineux/)).toBeInTheDocument()
  })
})
