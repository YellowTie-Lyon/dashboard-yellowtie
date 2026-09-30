import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getSupabase } from '../../lib/supabase'
import { AuthContext, type AuthState, type MfaState } from './auth-context'

async function computeMfa(): Promise<{ token: string | undefined; value: MfaState }> {
  const auth = getSupabase().auth
  const { data: current } = await auth.getSession()
  const token = current.session?.access_token
  const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel()
  if (error || !data) return { token, value: 'error' }
  if (data.currentLevel === 'aal2') return { token, value: 'ok' }
  return { token, value: data.nextLevel === 'aal2' ? 'challenge' : 'enroll' }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  // Le résultat est rattaché au jeton de session pour lequel il a été calculé : un ancien résultat ne peut jamais s'appliquer à une nouvelle session.
  const [mfaResult, setMfaResult] = useState<{ token: string | undefined; value: MfaState }>({ token: undefined, value: 'loading' })

  const refreshMfa = useCallback(async () => {
    setMfaResult(await computeMfa())
  }, [])

  // À chaque changement de session (connexion, code validé, jeton renouvelé), le niveau d'assurance est relu.
  const token = session?.access_token
  useEffect(() => {
    if (!token) return
    let active = true
    void computeMfa().then((result) => {
      if (active) setMfaResult(result)
    })
    return () => {
      active = false
    }
  }, [token])
  const mfa: MfaState = token && mfaResult.token === token ? mfaResult.value : 'loading'

  useEffect(() => {
    const supabase = getSupabase()
    let active = true

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setLoading(false)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setLoading(false)
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback<AuthState['signIn']>(async (email, password) => {
    const { error } = await getSupabase().auth.signInWithPassword({ email, password })
    // Message volontairement générique : ne révèle pas si l'e-mail existe.
    return { error: error ? 'Identifiants invalides.' : null }
  }, [])

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut()
  }, [])

  const value = useMemo<AuthState>(
    () => ({ session, user: session?.user ?? null, loading, signIn, signOut, mfa, refreshMfa }),
    [session, loading, signIn, signOut, mfa, refreshMfa],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
