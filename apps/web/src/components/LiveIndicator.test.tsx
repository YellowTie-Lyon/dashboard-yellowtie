import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LiveIndicator } from './LiveIndicator'

function Probe({ fail }: { fail?: boolean }) {
  useQuery({
    queryKey: ['probe'],
    queryFn: () => (fail ? Promise.reject(new Error('réseau')) : Promise.resolve('ok')),
    retry: false,
  })
  return null
}

function renderWith(fail = false) {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <Probe fail={fail} />
      <LiveIndicator />
    </QueryClientProvider>,
  )
}

describe('LiveIndicator', () => {
  it('signale une page en direct une fois les données chargées', async () => {
    renderWith()
    expect(await screen.findByText(/En direct · actualisé/)).toBeInTheDocument()
  })

  it('signale une connexion perdue quand la requête échoue', async () => {
    renderWith(true)
    expect(await screen.findByText(/Connexion perdue/)).toBeInTheDocument()
  })

  it('reste discret tant qu’aucune donnée n’est chargée', () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <LiveIndicator />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
