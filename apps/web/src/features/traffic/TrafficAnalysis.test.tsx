import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrafficView } from '../../lib/trafficView'
import { TrafficAnalysis } from './TrafficAnalysis'

const view: TrafficView = {
  scope: 'YellowTie-1',
  periodLabel: 'la dernière heure',
  minutes: 60,
  requests: 5000,
  totals: { r4xx: 1, r5xx: 1, posts: 800, bots: 1 },
  hostings: [],
  domains: [{ domain: 'exemple.fr', hosting: null, requests: 4000, r4xx: 0, r5xx: 0, posts: 700, bots: 0 }],
  paths: [{ domain: 'exemple.fr', path: '/wp-login.php', requests: 900, errors: 0, posts: 800 }],
  queries: [],
  uas: [],
  ips: [],
  ipdomains: [],
  domdetail: [],
  agents: null,
  sampled: false,
  detailed: true,
}

afterEach(() => vi.restoreAllMocks())

describe('TrafficAnalysis', () => {
  it('copie le rapport ChatGPT', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<TrafficAnalysis view={view} />)
    await user.click(screen.getByRole('button', { name: 'Copier le rapport pour ChatGPT' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('exemple.fr/wp-login.php'))
    expect(await screen.findByRole('button', { name: 'Rapport copié ✓' })).toBeInTheDocument()
  })

  it("copie l'expression d'une règle suggérée", async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<TrafficAnalysis view={view} />)
    await user.click(screen.getAllByRole('button', { name: "Copier l'expression" })[0]!)
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('http.host in'))
  })

  it("signale l'échec de copie", async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('no'))
    render(<TrafficAnalysis view={view} />)
    await user.click(screen.getByRole('button', { name: 'Copier le rapport pour ChatGPT' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Copie impossible')
  })

  it("n'affiche rien sans trafic", () => {
    const { container } = render(<TrafficAnalysis view={{ ...view, requests: 0 }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
