import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { ErrorNote } from '../../components/ErrorNote'
import { btn, btnDanger, btnPrimary, card, input, labelMono, mutedText } from '../../components/ui'
import { formatRelativeTime } from '../../lib/format'
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

  function onInvite(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    invite.mutate()
  }

  return (
    <section className="space-y-6" aria-label="Utilisateurs">
      <div>
        <p className={labelMono}>Accès · sur invitation</p>
        <h1 className="text-3xl font-extrabold tracking-tight">Utilisateurs</h1>
        <p className={`mt-1 max-w-3xl ${mutedText}`}>
          Chaque personne se connecte avec son e-mail, son mot de passe et un code de son application d'authentification
          (double authentification obligatoire). Il n'y a pas d'inscription libre : seul un propriétaire peut inviter.
        </p>
      </div>

      <form onSubmit={onInvite} className={`${card} grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end`}>
        <label className="text-sm font-medium">
          Inviter par e-mail
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@exemple.fr" className={input} />
        </label>
        <label className="text-sm font-medium">
          Rôle
          <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'viewer')} className={input}>
            <option value="viewer">Lecteur (consultation)</option>
            <option value="owner">Propriétaire (tous les droits)</option>
          </select>
        </label>
        <button type="submit" className={btnPrimary} disabled={invite.isPending || !email.trim()}>
          {invite.isPending ? 'Envoi…' : 'Envoyer l’invitation'}
        </button>
        <div className="sm:col-span-3">
          <ErrorNote error={invite.error} />
        </div>
      </form>

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
