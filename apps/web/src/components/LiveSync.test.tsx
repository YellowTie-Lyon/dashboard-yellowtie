import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_SYNC_MS } from '../lib/live'
import { LiveSync } from './LiveSync'

const a = vi.fn(() => Promise.resolve('a'))
const b = vi.fn(() => Promise.resolve('b'))
const frozen = vi.fn(() => Promise.resolve('c'))

function Probes() {
  useQuery({ queryKey: ['a'], queryFn: a })
  useQuery({ queryKey: ['b'], queryFn: b })
  useQuery({ queryKey: ['c'], queryFn: frozen, meta: { static: true } })
  return null
}

describe('LiveSync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    for (const f of [a, b, frozen]) f.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('recharge toutes les requêtes actives en même temps, sauf celles marquées statiques', async () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <Probes />
        <LiveSync />
      </QueryClientProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect([a.mock.calls.length, b.mock.calls.length, frozen.mock.calls.length]).toEqual([1, 1, 1])
    await act(async () => {
      vi.advanceTimersByTime(LIVE_SYNC_MS)
      await Promise.resolve()
    })
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)
    expect(frozen).toHaveBeenCalledTimes(1)
  })

  it('ne recharge rien quand l’onglet est masqué', async () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <Probes />
        <LiveSync />
      </QueryClientProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      vi.advanceTimersByTime(LIVE_SYNC_MS * 2)
      await Promise.resolve()
    })
    expect(a).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})
