import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from './auth-context'
import { MfaChallenge } from './MfaChallenge'
import { MfaEnroll } from './MfaEnroll'
import { RequireAuth } from './RequireAuth'
import { Route, Routes } from 'react-router-dom'

const mfa = {
  listFactors: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  challengeAndVerify: vi.fn(),
}
vi.mock('../../lib/supabase', () => ({ getSupabase: () => ({ auth: { mfa } }) }))

const refreshMfa = vi.fn()
const signOut = vi.fn()
function withAuth(ui: React.ReactNode, over: Partial<AuthState> = {}) {
  const value: AuthState = { session: null, user: { id: 'u', email: 'a@b.c' } as AuthState['user'], loading: false, signIn: vi.fn(), signOut, mfa: 'ok', refreshMfa, ...over }
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  for (const f of Object.values(mfa)) f.mockReset()
  refreshMfa.mockReset()
  signOut.mockReset()
})

describe('MfaEnroll', () => {
  it('crée un facteur TOTP, affiche le QR code et la clé, puis valide le code saisi', async () => {
    mfa.listFactors.mockResolvedValue({ data: { all: [] }, error: null })
    mfa.enroll.mockResolvedValue({ data: { id: 'f1', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCDSECRET' } }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    withAuth(<MfaEnroll />)
    expect(await screen.findByAltText(/QR code/)).toBeInTheDocument()
    expect(screen.getByText('ABCDSECRET')).toBeInTheDocument()
    expect(mfa.enroll).toHaveBeenCalledWith(expect.objectContaining({ factorType: 'totp', issuer: 'YellowScope' }))

    const button = screen.getByRole('button', { name: /Activer et continuer/ })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Code à 6 chiffres/), '12a3456')
    expect(screen.getByLabelText(/Code à 6 chiffres/)).toHaveValue('123456')
    await userEvent.click(button)
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '123456' })
    await waitFor(() => expect(refreshMfa).toHaveBeenCalled())
  })

  it('retire un facteur abandonné avant d’en créer un nouveau', async () => {
    mfa.listFactors.mockResolvedValue({ data: { all: [{ id: 'old', status: 'unverified' }, { id: 'ok', status: 'verified' }] }, error: null })
    mfa.unenroll.mockResolvedValue({ data: {}, error: null })
    mfa.enroll.mockResolvedValue({ data: { id: 'f2', totp: { qr_code: 'x', secret: 'S' } }, error: null })
    withAuth(<MfaEnroll />)
    await screen.findByAltText(/QR code/)
    expect(mfa.unenroll).toHaveBeenCalledTimes(1)
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: 'old' })
  })

  it('un code refusé affiche une erreur et ne débloque rien', async () => {
    mfa.listFactors.mockResolvedValue({ data: { all: [] }, error: null })
    mfa.enroll.mockResolvedValue({ data: { id: 'f1', totp: { qr_code: 'x', secret: 'S' } }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: null, error: { code: 'mfa_verification_failed', message: 'invalid' } })
    withAuth(<MfaEnroll />)
    await screen.findByAltText(/QR code/)
    await userEvent.type(screen.getByLabelText(/Code à 6 chiffres/), '000000')
    await userEvent.click(screen.getByRole('button', { name: /Activer et continuer/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Code incorrect/)
    expect(refreshMfa).not.toHaveBeenCalled()
  })
})

describe('MfaChallenge', () => {
  it('demande le code du facteur existant', async () => {
    mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f9' }] }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    withAuth(<MfaChallenge />)
    await userEvent.type(screen.getByLabelText(/Code à 6 chiffres/), '654321')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Valider' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f9', code: '654321' })
    await waitFor(() => expect(refreshMfa).toHaveBeenCalled())
  })

  it('propose de se déconnecter', async () => {
    mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f9' }] }, error: null })
    withAuth(<MfaChallenge />)
    await userEvent.click(screen.getByRole('button', { name: /Se déconnecter/ }))
    expect(signOut).toHaveBeenCalled()
  })
})

describe('RequireAuth et double authentification', () => {
  function gate(state: AuthState['mfa']) {
    mfa.listFactors.mockResolvedValue({ data: { all: [], totp: [{ id: 'f' }] }, error: null })
    mfa.enroll.mockResolvedValue({ data: { id: 'f1', totp: { qr_code: 'x', secret: 'S' } }, error: null })
    return withAuth(
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/" element={<p>contenu protégé</p>} />
        </Route>
      </Routes>,
      { mfa: state },
    )
  }

  it('n’affiche aucune page protégée tant que le code n’est pas validé', async () => {
    gate('challenge')
    expect(await screen.findByText('Code de vérification')).toBeInTheDocument()
    expect(screen.queryByText('contenu protégé')).not.toBeInTheDocument()
  })

  it('force la création du double facteur à la première connexion', async () => {
    gate('enroll')
    expect(await screen.findByText('Activer la double authentification')).toBeInTheDocument()
    expect(screen.queryByText('contenu protégé')).not.toBeInTheDocument()
  })

  it('n’ouvre rien si le niveau d’assurance est indéterminé', () => {
    gate('error')
    expect(screen.getByRole('alert')).toHaveTextContent(/Impossible de vérifier/)
    expect(screen.queryByText('contenu protégé')).not.toBeInTheDocument()
  })

  it('affiche le contenu une fois le double facteur validé', () => {
    gate('ok')
    expect(screen.getByText('contenu protégé')).toBeInTheDocument()
  })
})

describe('erreurs de vérification', () => {
  it('explique un TOTP désactivé sur le projet plutôt que de parler d’un mauvais code', async () => {
    mfa.listFactors.mockResolvedValue({ data: { all: [] }, error: null })
    mfa.enroll.mockResolvedValue({ data: { id: 'f1', totp: { qr_code: 'x', secret: 'S' } }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: null, error: { code: 'mfa_totp_verify_not_enabled', message: 'x' } })
    withAuth(<MfaEnroll />)
    await screen.findByAltText(/QR code/)
    await userEvent.type(screen.getByLabelText(/Code à 6 chiffres/), '123456')
    await userEvent.click(screen.getByRole('button', { name: /Activer et continuer/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/n’est pas activée sur le projet Supabase/)
  })
})
