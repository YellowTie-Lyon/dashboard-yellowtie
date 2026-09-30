import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorNote } from '../components/ErrorNote'
import { btnPrimary, input } from '../components/ui'
import { AuthCard } from '../features/auth/AuthCard'
import { useAuth } from '../features/auth/auth-context'
import { getSupabase } from '../lib/supabase'

const MIN_LENGTH = 12

/** Arrivée par le lien de l'e-mail (invitation ou mot de passe oublié) : la session est ouverte, il reste à choisir le mot de passe. */
export function WelcomePage() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-slate-400" role="status">Chargement…</div>

  if (!user) {
    return (
      <AuthCard title="Lien expiré ou invalide" subtitle="Les liens d'invitation et de réinitialisation ne sont valables qu'un temps limité.">
        <p className="text-sm text-slate-300">
          Demandez un nouveau lien : depuis la page de connexion (« Mot de passe oublié »), ou auprès d'un propriétaire pour une invitation.
        </p>
        <Link to="/login" className={`${btnPrimary} mt-5 w-full`}>Retour à la connexion</Link>
      </AuthCard>
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_LENGTH) return setError(new Error(`Le mot de passe doit contenir au moins ${MIN_LENGTH} caractères.`))
    if (password !== confirm) return setError(new Error('Les deux mots de passe ne sont pas identiques.'))
    setBusy(true)
    const { error: updateError } = await getSupabase().auth.updateUser({ password })
    setBusy(false)
    if (updateError) return setError(new Error("Impossible d'enregistrer ce mot de passe (trop simple ou déjà utilisé ?)."))
    void navigate('/', { replace: true })
  }

  return (
    <AuthCard title="Choisissez votre mot de passe" subtitle={user.email ?? undefined}>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <label className="block text-sm font-medium">
          Nouveau mot de passe
          <input type="password" autoComplete="new-password" required minLength={MIN_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
          <span className="mt-1 block text-xs font-normal text-slate-500">{MIN_LENGTH} caractères minimum. Un gestionnaire de mots de passe est recommandé.</span>
        </label>
        <label className="block text-sm font-medium">
          Confirmer
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        </label>
        <ErrorNote error={error} />
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>
          {busy ? 'Enregistrement…' : 'Enregistrer et continuer'}
        </button>
      </form>
      <p className="mt-4 text-xs text-slate-500">Étape suivante : activation de la double authentification.</p>
    </AuthCard>
  )
}
