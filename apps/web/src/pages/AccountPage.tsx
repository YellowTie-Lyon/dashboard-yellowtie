import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ErrorNote } from '../components/ErrorNote'
import { btn, btnPrimary, card, input, labelMono, mutedText } from '../components/ui'
import { useAuth } from '../features/auth/auth-context'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { getSupabase } from '../lib/supabase'

const MIN_LENGTH = 12
const ROLE_LABEL = { owner: 'Propriétaire', admin: 'Administrateur', viewer: 'Lecteur' } as const

/** Mon compte : mot de passe et double authentification de la personne connectée. */
export function AccountPage() {
  const { user, signOut } = useAuth()
  const { workspace } = useWorkspace()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [formError, setFormError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  const changePassword = useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().auth.updateUser({ password })
      if (error) throw new Error("Impossible d'enregistrer ce mot de passe (trop simple, identique à l'ancien ou session trop ancienne : reconnectez-vous).")
    },
    onSuccess: () => {
      setSaved(true)
      setPassword('')
      setConfirm('')
    },
  })

  // Réinitialiser son propre double facteur : on retire le facteur, puis on se déconnecte ; la prochaine connexion en crée un nouveau.
  const resetMfa = useMutation({
    mutationFn: async () => {
      const auth = getSupabase().auth
      const { data, error } = await auth.mfa.listFactors()
      if (error) throw error
      for (const f of data?.all ?? []) {
        const { error: unenrollError } = await auth.mfa.unenroll({ factorId: f.id })
        if (unenrollError) throw unenrollError
      }
      await signOut()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaved(false)
    setFormError(null)
    if (password.length < MIN_LENGTH) return setFormError(new Error(`Le mot de passe doit contenir au moins ${MIN_LENGTH} caractères.`))
    if (password !== confirm) return setFormError(new Error('Les deux mots de passe ne sont pas identiques.'))
    changePassword.mutate()
  }

  return (
    <section className="space-y-6">
      <div>
        <p className={labelMono}>Compte</p>
        <h1 className="text-3xl font-extrabold tracking-tight">Mon compte</h1>
        <p className={mutedText}>
          {user?.email}
          {workspace && ` · ${ROLE_LABEL[workspace.role]} de ${workspace.name}`}
        </p>
      </div>

      <form onSubmit={onSubmit} className={`${card} max-w-xl space-y-4`}>
        <h2 className="font-semibold">Changer mon mot de passe</h2>
        <label className="block text-sm font-medium">
          Nouveau mot de passe
          <input type="password" autoComplete="new-password" minLength={MIN_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Confirmer
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        </label>
        <ErrorNote error={formError ?? changePassword.error} />
        {saved && <p role="status" className="text-sm text-green-300">Mot de passe modifié.</p>}
        <button type="submit" className={btnPrimary} disabled={changePassword.isPending || !password}>
          {changePassword.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </form>

      <div className={`${card} max-w-xl`}>
        <h2 className="font-semibold">Double authentification</h2>
        <p className={`mt-1 ${mutedText}`}>
          Obligatoire. Changement de téléphone : réinitialisez-la ici. Vous serez déconnecté et vous scannerez un nouveau QR code à la prochaine connexion.
        </p>
        <button type="button" className={`${btn} mt-3`} onClick={() => setResetOpen(true)}>
          Réinitialiser mon double facteur
        </button>
      </div>

      <ConfirmDialog
        open={resetOpen}
        title="Réinitialiser la double authentification ?"
        message="Votre application d'authentification actuelle ne fonctionnera plus. Vous serez déconnecté et devrez en configurer une nouvelle."
        confirmLabel="Réinitialiser"
        pending={resetMfa.isPending}
        error={resetMfa.error}
        onConfirm={() => resetMfa.mutate()}
        onClose={() => setResetOpen(false)}
      />
    </section>
  )
}
