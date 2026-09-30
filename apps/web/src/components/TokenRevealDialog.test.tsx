import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TokenRevealDialog } from './TokenRevealDialog'

describe('TokenRevealDialog', () => {
  it('affiche le token et prévient qu’il ne sera plus visible', () => {
    render(<TokenRevealDialog token="ikh_abc_secret" hostingName="Web-1" onClose={vi.fn()} />)
    expect(screen.getByDisplayValue('ikh_abc_secret')).toBeInTheDocument()
    expect(screen.getByText(/ne sera plus jamais affiché/)).toBeInTheDocument()
  })

  it('propose une commande d’installation sans jamais y inclure le token', () => {
    render(<TokenRevealDialog token="ikh_abc_secret" hostingName="Web-1" onClose={vi.fn()} />)
    const command = screen.getByText(/ik-install\.sh --base-url/)
    expect(command).toBeInTheDocument()
    expect(command.textContent).not.toContain('ikh_abc_secret')
    expect(command.textContent).toContain('/agent/install.sh')
  })

  it('n’affiche rien sans token', () => {
    render(<TokenRevealDialog token={null} hostingName="Web-1" onClose={vi.fn()} />)
    expect(screen.queryByDisplayValue(/ikh_/)).not.toBeInTheDocument()
  })

  it('ferme via le bouton de confirmation', async () => {
    const onClose = vi.fn()
    render(<TokenRevealDialog token="ikh_abc_secret" hostingName="Web-1" onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: /J'ai copié le token/ }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
