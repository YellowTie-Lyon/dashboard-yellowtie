import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../features/auth/auth-context'
import { WelcomePage } from './WelcomePage'

const updateUser = vi.fn()
vi.mock('../lib/supabase', () => ({ getSupabase: () => ({ auth: { updateUser } }) }))

function renderAs(user: AuthState['user'] | null) {
  const value: AuthState = { session: null, user, loading: false, signIn: vi.fn(), signOut: vi.fn(), mfa: 'loading', refreshMfa: vi.fn() }
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/bienvenue']}>
        <Routes>
          <Route path="/bienvenue" element={<WelcomePage />} />
          <Route path="/" element={<p>accueil</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('WelcomePage', () => {
  beforeEach(() => updateUser.mockReset())

  it('signale un lien expiré quand aucune session n’est ouverte', () => {
    renderAs(null)
    expect(screen.getByText('Lien expiré ou invalide')).toBeInTheDocument()
  })

  it('refuse un mot de passe trop court ou non confirmé', async () => {
    renderAs({ id: 'u', email: 'a@b.c' } as AuthState['user'])
    await userEvent.type(screen.getByLabelText(/Nouveau mot de passe/), 'court123456')
    await userEvent.type(screen.getByLabelText('Confirmer'), 'autre-chose-123')
    await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/pas identiques|au moins/)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('enregistre le mot de passe puis continue vers l’application', async () => {
    updateUser.mockResolvedValue({ error: null })
    renderAs({ id: 'u', email: 'a@b.c' } as AuthState['user'])
    await userEvent.type(screen.getByLabelText(/Nouveau mot de passe/), 'un-mot-de-passe-solide')
    await userEvent.type(screen.getByLabelText('Confirmer'), 'un-mot-de-passe-solide')
    await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(updateUser).toHaveBeenCalledWith({ password: 'un-mot-de-passe-solide' })
    expect(await screen.findByText('accueil')).toBeInTheDocument()
  })
})
