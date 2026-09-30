import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { UpdateAgentDialog } from './UpdateAgentDialog'

describe('UpdateAgentDialog', () => {
  it('affiche la commande de mise à jour, sans token, en précisant que rien n’est régénéré', () => {
    render(<UpdateAgentDialog open hostingName="Web-1" onClose={vi.fn()} />)
    expect(screen.getByText(/rien n'est régénéré/)).toBeInTheDocument()
    expect(screen.getByText(/ik-install\.sh --base-url/)).toBeInTheDocument()
    expect(screen.getByText(/appuyez sur/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/ikh_[0-9a-f]{12}_/)
  })

  it('se ferme', async () => {
    const onClose = vi.fn()
    render(<UpdateAgentDialog open hostingName="Web-1" onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(onClose).toHaveBeenCalled()
  })
})
