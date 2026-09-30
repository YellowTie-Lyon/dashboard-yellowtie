import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceMember } from '../../lib/types'
import { UsersPanel } from './UsersPanel'

const fetchMembers = vi.fn<() => Promise<WorkspaceMember[]>>()
const setMemberRole = vi.fn()
const manageUsers = vi.fn()
vi.mock('./api', () => ({
  fetchMembers: () => fetchMembers(),
  setMemberRole: (...a: unknown[]) => setMemberRole(...a),
  manageUsers: (...a: unknown[]) => manageUsers(...a),
}))

const member = (o: Partial<WorkspaceMember>): WorkspaceMember => ({
  workspace_id: 'w', user_id: 'u1', email: 'moi@exemple.fr', role: 'owner', joined_at: '2026-09-01T00:00:00Z',
  last_sign_in_at: new Date().toISOString(), mfa_enabled: true, is_self: true, ...o,
})

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <UsersPanel />
    </QueryClientProvider>,
  )
}

describe('UsersPanel', () => {
  beforeEach(() => {
    fetchMembers.mockReset()
    setMemberRole.mockReset()
    manageUsers.mockReset()
    fetchMembers.mockResolvedValue([member({}), member({ user_id: 'u2', email: 'lecteur@exemple.fr', role: 'viewer', is_self: false, mfa_enabled: false, last_sign_in_at: null })])
  })

  it('liste les membres avec leur double facteur et distingue « vous »', async () => {
    renderIt()
    expect(await screen.findByText('lecteur@exemple.fr')).toBeInTheDocument()
    expect(screen.getByText('vous')).toBeInTheDocument()
    expect(screen.getByText('2FA : activée')).toBeInTheDocument()
    expect(screen.getByText('2FA : à configurer')).toBeInTheDocument()
    expect(screen.getByText(/invitation en attente/)).toBeInTheDocument()
  })

  it("ne propose ni suppression ni réinitialisation pour soi-même, et bloque son propre rôle", async () => {
    renderIt()
    await screen.findByText('lecteur@exemple.fr')
    expect(screen.getAllByRole('button', { name: 'Supprimer' })).toHaveLength(1)
    expect(screen.getByRole('combobox', { name: 'Rôle de moi@exemple.fr' })).toBeDisabled()
  })

  it('invite un utilisateur avec le rôle choisi', async () => {
    manageUsers.mockResolvedValue(undefined)
    renderIt()
    await screen.findByText('lecteur@exemple.fr')
    await userEvent.type(screen.getByLabelText('Inviter par e-mail'), 'nouveau@exemple.fr')
    await userEvent.selectOptions(screen.getByLabelText('Rôle'), 'owner')
    await userEvent.click(screen.getByRole('button', { name: /Envoyer l’invitation/ }))
    expect(manageUsers).toHaveBeenCalledWith({ action: 'invite', email: 'nouveau@exemple.fr', role: 'owner' })
    expect(await screen.findByRole('status')).toHaveTextContent('Invitation envoyée à nouveau@exemple.fr')
  })

  it("affiche l'erreur renvoyée par le serveur", async () => {
    manageUsers.mockRejectedValue(new Error('Cet utilisateur fait déjà partie du workspace.'))
    renderIt()
    await screen.findByText('lecteur@exemple.fr')
    await userEvent.type(screen.getByLabelText('Inviter par e-mail'), 'lecteur@exemple.fr')
    await userEvent.click(screen.getByRole('button', { name: /Envoyer l’invitation/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('fait déjà partie')
  })

  it('change le rôle d’un membre', async () => {
    setMemberRole.mockResolvedValue(undefined)
    renderIt()
    await screen.findByText('lecteur@exemple.fr')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Rôle de lecteur@exemple.fr' }), 'owner')
    expect(setMemberRole).toHaveBeenCalledWith('u2', 'owner')
  })

  it('demande confirmation avant de supprimer', async () => {
    manageUsers.mockResolvedValue(undefined)
    renderIt()
    await screen.findByText('lecteur@exemple.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    expect(manageUsers).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Supprimer cet utilisateur ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }))
    expect(manageUsers).toHaveBeenCalledWith({ action: 'remove', userId: 'u2' })
  })

  it('réinitialise le double facteur après confirmation', async () => {
    manageUsers.mockResolvedValue(undefined)
    renderIt()
    await screen.findByText('lecteur@exemple.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser le 2FA' }))
    const dialog = await screen.findByRole('dialog', { name: /Réinitialiser la double authentification/ })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Réinitialiser' }))
    expect(manageUsers).toHaveBeenCalledWith({ action: 'reset_mfa', userId: 'u2' })
  })
})
