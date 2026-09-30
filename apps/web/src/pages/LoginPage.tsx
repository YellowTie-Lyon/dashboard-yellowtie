import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { ErrorNote } from '../components/ErrorNote'
import { btnPrimary, input } from '../components/ui'
import { AuthCard } from '../features/auth/AuthCard'
import { useAuth } from '../features/auth/auth-context'
import { getSupabase } from '../lib/supabase'

export function LoginPage() {
  const { user, loading, signIn } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={from} replace />
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await signIn(email.trim(), password)
    if (result.error) setError(result.error)
    setSubmitting(false)
  }

  async function forgotPassword() {
    if (!email.trim()) return setError("Saisissez d'abord votre e-mail ci-dessus.")
    setError(null)
    // Réponse identique que le compte existe ou non : on ne révèle rien.
    await getSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/bienvenue` })
    setResetSent(true)
  }

  return (
    <AuthCard title="Connexion" subtitle="Réservée aux personnes invitées.">
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <label className="block text-sm font-medium">
          E-mail
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Mot de passe
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        </label>
        <ErrorNote error={error ? new Error(error) : null} />
        {resetSent && (
          <p role="status" className="text-sm text-green-300">
            Si un compte correspond à cette adresse, un e-mail de réinitialisation vient d'être envoyé.
          </p>
        )}
        <button type="submit" disabled={submitting} className={`${btnPrimary} w-full`}>
          {submitting ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
      <button type="button" onClick={() => void forgotPassword()} className="mt-4 w-full text-center text-sm text-slate-400 underline">
        Mot de passe oublié ?
      </button>
      <p className="mt-4 text-center text-xs text-slate-500">Un code de votre application d'authentification vous sera demandé ensuite.</p>
    </AuthCard>
  )
}
