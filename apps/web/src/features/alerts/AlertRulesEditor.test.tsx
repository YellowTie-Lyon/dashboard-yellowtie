import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertRule, MetricPercentiles, Metric } from '../../lib/types'
import { AlertRulesEditor } from './AlertRulesEditor'

const fetchAlertRules = vi.fn<() => Promise<AlertRule[]>>()
const fetchPercentiles = vi.fn<(id: string) => Promise<MetricPercentiles[]>>()
const createRule = vi.fn()
const updateRule = vi.fn()
const deleteRule = vi.fn()
const refreshStatuses = vi.fn()
let canWrite = true

vi.mock('./api', () => ({
  fetchAlertRules: () => fetchAlertRules(),
  fetchPercentiles: (id: string) => fetchPercentiles(id),
  createRule: (...a: unknown[]) => createRule(...a),
  updateRule: (...a: unknown[]) => updateRule(...a),
  deleteRule: (...a: unknown[]) => deleteRule(...a),
  refreshStatuses: () => refreshStatuses(),
}))
vi.mock('../workspace/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'w1', name: 'YellowTie', role: 'owner' }, isPending: false, error: null, canWrite }),
}))

const METRICS: Metric[] = ['load1_per_core', 'load5_per_core', 'load1', 'load5', 'cpu_pct', 'mem_used_pct', 'swap_used_pct', 'disk_used_pct']
function rules(): AlertRule[] {
  return METRICS.map((metric, i) => ({
    id: `d${i}`, workspace_id: 'w1', cloud_server_id: null, metric, warn_threshold: 0.6, crit_threshold: 1, window_minutes: 5,
    min_breach_ratio: 0.8, recover_margin: 0.1, recover_minutes: 5, enabled: true,
  }))
}

function renderEditor(cloudId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AlertRulesEditor cloudId={cloudId} calibrationCloudId="c1" />
    </QueryClientProvider>,
  )
}

function row(title: string) {
  return screen.getByRole('heading', { name: new RegExp(title) }).closest('form') as HTMLFormElement
}

describe('AlertRulesEditor', () => {
  beforeEach(() => {
    canWrite = true
    for (const f of [createRule, updateRule, deleteRule, refreshStatuses]) f.mockReset().mockResolvedValue(undefined)
    fetchAlertRules.mockReset().mockResolvedValue(rules())
    fetchPercentiles.mockReset().mockResolvedValue([{ metric: 'load1_per_core', n: 10080, p50: 0.21, p95: 0.48, p99: 0.71, max: 1.3 }])
  })

  it('affiche les huit règles avec leurs six réglages modifiables', async () => {
    renderEditor(null)
    expect(await screen.findByRole('heading', { name: /Load 1 min par cœur/ })).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    const form = row('Load 1 min par cœur')
    expect(within(form).getAllByRole('textbox')).toHaveLength(6)
  })

  it('montre la distribution réelle des mesures pour aider à calibrer', async () => {
    renderEditor(null)
    expect(await screen.findByText(/médiane 0,21 · p95 0,48 · p99 0,71 · max 1,30/)).toBeInTheDocument()
  })

  it('enregistre une règle par défaut puis recalcule les statuts', async () => {
    renderEditor(null)
    await screen.findByRole('heading', { name: /Load 1 min par cœur/ })
    const form = row('Load 1 min par cœur')
    const [warn] = within(form).getAllByRole('textbox')
    await userEvent.clear(warn!)
    await userEvent.type(warn!, '0,8')
    await userEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(updateRule).toHaveBeenCalled())
    expect(updateRule.mock.calls[0]?.[0]).toBe('d0')
    expect(updateRule.mock.calls[0]?.[1]).toMatchObject({ warn_threshold: 0.8, crit_threshold: 1, window_minutes: 5, min_breach_ratio: 0.8 })
    await waitFor(() => expect(refreshStatuses).toHaveBeenCalled())
  })

  it('refuse un seuil Critical inférieur au Warning sans rien envoyer', async () => {
    renderEditor(null)
    await screen.findByRole('heading', { name: /Load 1 min par cœur/ })
    const form = row('Load 1 min par cœur')
    const boxes = within(form).getAllByRole('textbox')
    await userEvent.clear(boxes[1]!)
    await userEvent.type(boxes[1]!, '0,5')
    await userEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/strictement supérieur/)
    expect(updateRule).not.toHaveBeenCalled()
  })

  it('personnalise pour un Cloud (création d’une surcharge), sans toucher à la valeur par défaut', async () => {
    renderEditor('c1')
    await screen.findByRole('heading', { name: /CPU/ })
    const form = row('CPU')
    expect(within(form).getByText('Valeur par défaut')).toBeInTheDocument()
    await userEvent.click(within(form).getByRole('button', { name: 'Personnaliser pour ce Cloud' }))
    await waitFor(() => expect(createRule).toHaveBeenCalledWith('w1', 'c1', 'cpu_pct', expect.objectContaining({ warn_threshold: 0.6 })))
    expect(updateRule).not.toHaveBeenCalled()
  })

  it('affiche une surcharge existante et permet de revenir à la valeur par défaut', async () => {
    fetchAlertRules.mockResolvedValue([...rules(), { ...rules()[4]!, id: 'o1', cloud_server_id: 'c1', warn_threshold: 70 }])
    renderEditor('c1')
    await screen.findByRole('heading', { name: /CPU/ })
    const form = row('CPU')
    expect(within(form).getByText('Personnalisée pour ce Cloud')).toBeInTheDocument()
    await userEvent.click(within(form).getByRole('button', { name: 'Revenir à la valeur par défaut' }))
    await waitFor(() => expect(deleteRule).toHaveBeenCalledWith('o1'))
  })

  it('est en lecture seule pour un simple lecteur', async () => {
    canWrite = false
    renderEditor(null)
    await screen.findByRole('heading', { name: /Load 1 min par cœur/ })
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument()
    expect(within(row('Load 1 min par cœur')).getAllByRole('textbox')[0]).toBeDisabled()
  })
})
