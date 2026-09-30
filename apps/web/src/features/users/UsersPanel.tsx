import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { ErrorNote } from '../../components/ErrorNote'
import { btn, btnDanger, btnPrimary, card, input, labelMono, mutedText } from '../../components/ui'
import { formatRelativeTime } from '../../lib/format'
import { generatePassword } from '../../lib/password'
import type { WorkspaceMember, WorkspaceRole } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { fetchMembers, manageUsers, setMemberRole } from './api'

const ROLE_LABEL: Record<string, string> = { owner: 'Propriétaire', admin: 'Administrateur', viewer: 'Lecteur' }

type Pending = { kind: 'remove' | 'reset_mfa'; member: WorkspaceMember } | null

/** Gestion des utilisateurs du workspace (propriétaires) : invitation par e-mail, rôle, double facteur, suppression. */
export function UsersPanel() {
  const queryClient = useQueryClient()
  const now = useNow(60_000)
  const members = useQuery({ queryKey: ['members'], queryFn: fetchMembers })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'viewer'>('viewer')
  const [mode, setMode] = useState<'invite' | 'create'>('invite')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] })

  const invite = useMutation({
    mutationFn: () => manageUsers({ action: 'invite', email: email.trim(), role }),
    onSuccess: async () => {
      setNotice(`Invitation envoyée à ${email.trim()}. Le lien contenu dans l'e-mail lui permet de choisir son mot de passe.`)
      setEmail('')
      await refresh()
    },
  })
  const create = useMutation({
    mutationFn: () => manageUsers({ action: 'create', email: email.trim(), password, role }),
    onSuccess: async () => {
      // Le mot de passe n'est affiché qu'ici, une seule fois ; il n'est conservé nulle part ailleurs.
      setRevealed({ email: email.trim(), password })
      setEmail('')
      setPassword('')
      setCopied(false)
      await refresh()
    },
  })
  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: WorkspaceRole }) => setMemberRole(v.userId, v.role),
    onSuccess: refresh,
  })
  const act = useMutation({
    mutationFn: (p: NonNullable<Pending>) => manageUsers({ action: p.kind, userId: p.member.user_id }),
    onSuccess: async (_d, p) => {
      setNotice(p.kind === 'remove' ? `${p.member.email} a été supprimé.` : `Double authentification de ${p.member.email} réinitialisée : il devra en créer une nouvelle à sa prochaine connexion.`)
      setPending(null)
      await refresh()
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    setRevealed(null)
    if (mode === 'invite') invite.mutate()
    else create.mutate()
  }

  async function copyPassword() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.password)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const busy = invite.isPending || create.isPending
  const canSubmit = Boolean(email.trim()) && (mode === 'invite' || password.length >= 12)

  return (
    <section className="space-y-6" aria-label="Utilisateurs">
      <div>
        <p className={labelMono}>Accès · sur invitation</p>
        <h1 className="text-3xl font-extrabold tracking-tight">Utilisateurs</h1>
        <p className={`mt-1 max-w-3xl ${mutedText}`}>
          Chaque personne se connecte avec son e-mail, son mot de passe et un code de son application d'authentification
          (double authentification obligatoire). Il n'y a pas d'inscription libre : seul un propriétaire peut ajouter quelqu'un.
        </p>
      </div>

      <form onSubmit={onSubmit} className={`${card} space-y-4`}>
        <div role="group" aria-label="Mode d'ajout" className="flex flex-wrap gap-1.5">
          {(
            [
              ['invite', 'Inviter par e-mail'],
              ['create', 'Créer avec un mot de passe'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => setMode(key)}
              className={`rounded-full border px-3 py-1 text-sm font-medium ${mode === key ? 'border-brand bg-brand text-slate-950' : 'border-white/15 hover:bg-white/10'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={mutedText}>
          {mode === 'invite'
            ? "La personne reçoit un e-mail avec un lien pour choisir son mot de passe (nécessite l'envoi d'e-mails de Supabase)."
            : "Le compte est créé tout de suite, sans e-mail. Vous transmettez vous-même le mot de passe (canal sûr) ; la personne le changera dans « Mon compte »."}
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem] sm:items-end">
          <label className="text-sm font-medium">
            Adresse e-mail
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@exemple.fr" className={input} />
          </label>
          <label className="text-sm font-medium">
            Rôle
            <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'viewer')} className={input}>
              <option value="viewer">Lecteur (consultation)</option>
              <option value="owner">Propriétaire (tous les droits)</option>
            </select>
          </label>
        </div>
        {mode === 'create' && (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="text-sm font-medium">
              Mot de passe (12 caractères minimum)
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                minLength={12}
                maxLength={72}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${input} font-mono`}
              />
            </label>
            <button type="button" className={btn} onClick={() => setPassword(generatePassword())}>
              Générer un mot de passe
            </button>
          </div>
        )}
        <ErrorNote error={invite.error ?? create.error} />
        <button type="submit" className={btnPrimary} disabled={busy || !canSubmit}>
          {busy ? 'Envoi…' : mode === 'invite' ? 'Envoyer l’invitation' : 'Créer le compte'}
        </button>
      </form>

      {revealed && (
        <div role="status" className="rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm">
          <p className="font-medium text-green-300">Compte créé pour {revealed.email}.</p>
          <p className="mt-1 text-slate-300">
            Mot de passe (affiché une seule fois) : <code className="select-all rounded bg-white/10 px-1.5 py-0.5 font-mono">{revealed.password}</code>
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Transmettez-le par un canal sûr (gestionnaire de mots de passe). À sa première connexion, la personne créera son double authentification
            (Google Authenticator) et pourra changer son mot de passe dans « Mon compte ».
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={btn} onClick={() => void copyPassword()}>
              {copied ? 'Copié ✓' : 'Copier le mot de passe'}
            </button>
            <button type="button" className={btn} onClick={() => setRevealed(null)}>
              J’ai noté le mot de passe
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p role="status" className="rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-green-300">
          {notice}
        </p>
      )}

      <ErrorNote error={members.error ?? changeRole.error} />
      {members.isPending && <p className={mutedText}>Chargement…</p>}

      {members.data && (
        <ul className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.03]">
          {members.data.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate font-semibold">
                  {m.email}
                  {m.is_self && <span className="ml-2 rounded-full border border-white/15 px-2 py-0.5 text-xs font-normal text-slate-300">vous</span>}
                </p>
                <p className="text-xs text-slate-500">
                  {m.last_sign_in_at ? `Dernière connexion ${formatRelativeTime(m.last_sign_in_at, now)}` : 'Jamais connecté (invitation en attente)'}
                </p>
              </div>

              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m.mfa_enabled ? 'bg-green-500/10 text-green-300' : 'bg-orange-500/10 text-orange-300'}`}
                title={m.mfa_enabled ? 'Application d’authentification configurée' : 'Sera demandée à la première connexion'}
              >
                2FA : {m.mfa_enabled ? 'activée' : 'à configurer'}
              </span>

              <label className="text-sm">
                <span className="sr-only">Rôle de {m.email}</span>
                <select
                  value={m.role}
                  disabled={m.is_self || changeRole.isPending}
                  onChange={(e) => changeRole.mutate({ userId: m.user_id, role: e.target.value as WorkspaceRole })}
                  className="rounded-full border border-white/15 bg-transparent px-3 py-1.5 text-sm disabled:opacity-60"
                >
                  <option value="viewer">{ROLE_LABEL.viewer}</option>
                  <option value="owner">{ROLE_LABEL.owner}</option>
                  {m.role === 'admin' && <option value="admin">{ROLE_LABEL.admin}</option>}
                </select>
              </label>

              {!m.is_self && (
                <div className="flex gap-2">
                  <button type="button" className={btn} onClick={() => setPending({ kind: 'reset_mfa', member: m })}>
                    Réinitialiser le 2FA
                  </button>
                  <button type="button" className={btnDanger} onClick={() => setPending({ kind: 'remove', member: m })}>
                    Supprimer
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'remove' ? 'Supprimer cet utilisateur ?' : 'Réinitialiser la double authentification ?'}
        message={
          pending
            ? pending.kind === 'remove'
              ? `${pending.member.email} n'aura plus aucun accès et son compte sera supprimé.`
              : `${pending.member.email} devra configurer une nouvelle application d'authentification à sa prochaine connexion (à utiliser s'il a perdu ou changé de téléphone).`
            : ''
        }
        confirmLabel={pending?.kind === 'remove' ? 'Supprimer' : 'Réinitialiser'}
        pending={act.isPending}
        error={act.error}
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => {
          setPending(null)
          act.reset()
        }}
      />
    </section>
  )
}
