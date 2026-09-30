import type { Session, User } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'

/**
 * Double authentification : 'ok' = session aal2 (code TOTP validé) ; 'enroll' = aucun facteur, à créer ; 'challenge' = facteur existant,
 * code à saisir ; 'loading' = calcul en cours ; 'error' = impossible de le déterminer (on n'ouvre RIEN par défaut).
 */
export type MfaState = 'loading' | 'enroll' | 'challenge' | 'ok' | 'error'

export interface AuthState {
  session: Session | null
  user: User | null
  /** Vrai tant que la session initiale n'a pas été lue. */
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  mfa: MfaState
  refreshMfa: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>.')
  return ctx
}
