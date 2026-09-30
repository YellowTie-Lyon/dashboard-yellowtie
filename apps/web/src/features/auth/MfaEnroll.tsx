import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ErrorNote } from '../../components/ErrorNote'
import { btnPrimary, input } from '../../components/ui'
import { mfaErrorMessage } from '../../lib/errors'
import { getSupabase } from '../../lib/supabase'
import { AuthCard } from './AuthCard'
import { useAuth } from './auth-context'

interface Enrollment {
  factorId: string
  qr: string
  secret: string
}

/** Première connexion : création du double facteur (application d'authentification : Google Authenticator, Authy, 1Password…). */
export function MfaEnroll() {
  const { refreshMfa, signOut } = useAuth()
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const auth = getSupabase().auth
      // Une inscription abandonnée laisse un facteur « non vérifié » qui bloquerait la suivante : on le retire.
      const { data: existing } = await auth.mfa.listFactors()
      for (const f of existing?.all ?? []) if (f.status === 'unverified') await auth.mfa.unenroll({ factorId: f.id })
      const { data, error: enrollError } = await auth.mfa.enroll({ factorType: 'totp', issuer: 'YellowScope', friendlyName: `YellowScope ${new Date().toISOString().slice(0, 10)}` })
      if (enrollError || !data) return setError(enrollError ?? new Error("Impossible de créer le double facteur."))
      setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret })
    })()
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!enrollment) return
    setBusy(true)
    setError(null)
    const { error: verifyError } = await getSupabase().auth.mfa.challengeAndVerify({ factorId: enrollment.factorId, code: code.trim() })
    if (verifyError) {
      setError(new Error(mfaErrorMessage(verifyError)))
      setCode('')
      setBusy(false)
      return
    }
    await refreshMfa()
    setBusy(false)
  }

  return (
    <AuthCard title="Activer la double authentification" subtitle="Obligatoire pour accéder à YellowScope.">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
        <li>Installez <strong>Google Authenticator</strong> (ou Authy, 1Password…) sur votre téléphone.</li>
        <li>Dans l'application, ajoutez un compte et <strong>scannez ce QR code</strong>.</li>
        <li>Saisissez le code à 6 chiffres qui s'affiche.</li>
      </ol>

      <div className="mt-4 grid place-items-center rounded-xl bg-white p-3">
        {enrollment ? (
          <img src={enrollment.qr} alt="QR code à scanner avec l'application d'authentification" className="size-48" />
        ) : (
          <p className="grid size-48 place-items-center text-sm text-slate-600" role="status">Préparation…</p>
        )}
      </div>
      {enrollment && (
        <p className="mt-2 text-center text-xs text-slate-400">
          Impossible de scanner ? Saisissez cette clé dans l'application :
          <code className="mt-1 block select-all break-all font-mono text-slate-200">{enrollment.secret}</code>
        </p>
      )}

      <form onSubmit={(e) => void onSubmit(e)} className="mt-5">
        <label className="block text-sm font-medium">
          Code à 6 chiffres
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
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
        <button type="submit" disabled={busy || !enrollment || code.length !== 6} className={`${btnPrimary} mt-4 w-full`}>
          {busy ? 'Vérification…' : 'Activer et continuer'}
        </button>
      </form>
      <button type="button" onClick={() => void signOut()} className="mt-4 w-full text-center text-sm text-slate-400 underline">
        Se déconnecter
      </button>
    </AuthCard>
  )
}
