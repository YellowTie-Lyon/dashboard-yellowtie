import { useEffect, useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ErrorNote'
import { btnPrimary, input } from '../../components/ui'
import { getSupabase } from '../../lib/supabase'
import { AuthCard } from './AuthCard'
import { useAuth } from './auth-context'

/** Connexions suivantes : saisie du code TOTP de l'application d'authentification. */
export function MfaChallenge() {
  const { refreshMfa, signOut } = useAuth()
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getSupabase()
      .auth.mfa.listFactors()
      .then(({ data, error: listError }) => {
        if (listError) return setError(listError)
        const totp = data?.totp?.[0]
        if (!totp) return setError(new Error('Aucun facteur trouvé. Contactez un propriétaire pour réinitialiser votre double authentification.'))
        setFactorId(totp.id)
      })
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true)
    setError(null)
    const { error: verifyError } = await getSupabase().auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    if (verifyError) {
      setError(new Error('Code incorrect ou expiré. Un nouveau code apparaît toutes les 30 secondes.'))
      setCode('')
      setBusy(false)
      return
    }
    await refreshMfa()
    setBusy(false)
  }

  return (
    <AuthCard title="Code de vérification" subtitle="Ouvrez votre application d'authentification (Google Authenticator…) et saisissez le code à 6 chiffres.">
      <form onSubmit={(e) => void onSubmit(e)}>
        <label className="block text-sm font-medium">
          Code à 6 chiffres
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className={`${input} text-center font-mono text-lg tracking-[0.4em]`}
          />
        </label>
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
        <button type="submit" disabled={busy || !factorId || code.length !== 6} className={`${btnPrimary} mt-4 w-full`}>
          {busy ? 'Vérification…' : 'Valider'}
        </button>
      </form>
      <p className="mt-4 text-xs text-slate-400">Téléphone perdu ? Demandez à un propriétaire de réinitialiser votre double authentification (page Utilisateurs).</p>
      <button type="button" onClick={() => void signOut()} className="mt-3 w-full text-center text-sm text-slate-400 underline">
        Se déconnecter
      </button>
    </AuthCard>
  )
}
