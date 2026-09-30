import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from './auth-context'
import { RequireAuth } from './RequireAuth'

function renderAt(state: Partial<AuthState>) {
  const value: AuthState = {
    session: null,
    user: null,
    loading: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    ...state,
  }
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<p>contenu protégé</p>} />
          </Route>
          <Route path="/login" element={<p>page de connexion</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('RequireAuth', () => {
  it('redirige vers /login sans utilisateur', () => {
    renderAt({})
    expect(screen.getByText('page de connexion')).toBeInTheDocument()
    expect(screen.queryByText('contenu protégé')).not.toBeInTheDocument()
  })

  it('affiche un état de chargement tant que la session est lue', () => {
    renderAt({ loading: true })
    expect(screen.getByRole('status')).toHaveTextContent('Chargement')
    expect(screen.queryByText('page de connexion')).not.toBeInTheDocument()
  })

  it('affiche le contenu pour un utilisateur connecté', () => {
    renderAt({ user: { id: 'u1', email: 'a@b.c' } as AuthState['user'] })
    expect(screen.getByText('contenu protégé')).toBeInTheDocument()
  })
})
