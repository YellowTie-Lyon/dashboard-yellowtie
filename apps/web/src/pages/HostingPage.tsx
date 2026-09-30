import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Dialog } from '../components/Dialog'
import { ErrorNote } from '../components/ErrorNote'
import { TokenRevealDialog } from '../components/TokenRevealDialog'
import { btn, btnDanger, btnPrimary, card, input, mutedText } from '../components/ui'
import {
  deleteHosting,
  deleteSite,
  fetchCloud,
  fetchHosting,
  fetchHostingStates,
  fetchSites,
  importSites,
  revokeHostingToken,
  rotateHostingToken,
  setSiteActive,
  setSystemCollector,
} from '../features/inventory/api'
import { HostingFormDialog } from '../features/inventory/HostingFormDialog'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { formatBytes, formatRelativeTime } from '../lib/format'
import { ANOMALY_LABELS } from '../lib/labels'
import { useNow } from '../lib/useNow'
import type { ImportSitesResult, Site } from '../lib/types'

export function HostingPage() {
  const { hostingId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { canWrite } = useWorkspace()

  const hosting = useQuery({ queryKey: ['hosting', hostingId], queryFn: () => fetchHosting(hostingId) })
  const cloudId = hosting.data?.cloud_server_id
  const cloud = useQuery({
    queryKey: ['cloud', cloudId],
    queryFn: () => fetchCloud(cloudId!),
    enabled: Boolean(cloudId),
  })
  const sites = useQuery({ queryKey: ['sites', hostingId], queryFn: () => fetchSites(hostingId) })
  const agentState = useQuery({
    queryKey: ['hosting-state', hostingId],
    queryFn: async () => (await fetchHostingStates([hostingId]))[0] ?? null,
    refetchInterval: 30_000,
  })
  const now = useNow()

  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [revealedToken, setRevealedToken] = useState<string | null>(null)
  const [siteToDelete, setSiteToDelete] = useState<Site | null>(null)
  const [search, setSearch] = useState('')

  const refreshHosting = async () => {
    await queryClient.invalidateQueries({ queryKey: ['hosting', hostingId] })
    await queryClient.invalidateQueries({ queryKey: ['hostings'] })
  }

  const rotate = useMutation({
    mutationFn: (graceMinutes: number) => rotateHostingToken(hostingId, graceMinutes),
    onSuccess: async (token) => {
      setRotateOpen(false)
      setRevealedToken(token)
      await refreshHosting()
    },
  })
  const revoke = useMutation({
    mutationFn: () => revokeHostingToken(hostingId),
    onSuccess: async () => {
      setRevokeOpen(false)
      await refreshHosting()
    },
  })
  const collector = useMutation({ mutationFn: () => setSystemCollector(hostingId), onSuccess: refreshHosting })
  const remove = useMutation({
    mutationFn: () => deleteHosting(hostingId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['hostings'] })
      await queryClient.invalidateQueries({ queryKey: ['clouds'] })
      void navigate(cloudId ? `/clouds/${cloudId}` : '/', { replace: true })
    },
  })
  const toggleSite = useMutation({
    mutationFn: (site: Site) => setSiteActive(site.id, !site.is_active),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sites', hostingId] }),
  })
  const removeSite = useMutation({
    mutationFn: (site: Site) => deleteSite(site.id),
    onSuccess: async () => {
      setSiteToDelete(null)
      await queryClient.invalidateQueries({ queryKey: ['sites', hostingId] })
      await queryClient.invalidateQueries({ queryKey: ['clouds'] })
      await queryClient.invalidateQueries({ queryKey: ['hostings'] })
    },
  })

  const filteredSites = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (sites.data ?? []).filter((s) => !term || s.domain.includes(term))
  }, [sites.data, search])

  if (hosting.isPending) return <p className={mutedText}>Chargement…</p>
  if (hosting.error) return <ErrorNote error={hosting.error} />
  if (!hosting.data) {
    return (
      <div>
        <p className="font-medium">Hébergement introuvable.</p>
        <Link to="/" className="text-sm underline">
          Retour
        </Link>
      </div>
    )
  }

  const h = hosting.data

  return (
    <section className="space-y-6">
      <div>
        <Link
          to={cloudId ? `/clouds/${cloudId}` : '/'}
          className="text-sm text-slate-500 hover:underline dark:text-slate-400"
        >
          ← {cloud.data?.name ?? 'Server Cloud'}
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{h.name}</h1>
            {h.system_metrics_collector && (
              <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-900 dark:bg-yellow-950 dark:text-yellow-300">
                Collecteur système
              </span>
            )}
            {!h.is_active && (
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                Inactif
              </span>
            )}
          </div>
          {canWrite && (
            <div className="flex gap-2">
              <button type="button" className={btn} onClick={() => setEditing(true)}>
                Modifier
              </button>
              <button type="button" className={btnDanger} onClick={() => setDeleting(true)}>
                Supprimer
              </button>
            </div>
          )}
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
          <div>
            <dt className="inline text-slate-400">Server Cloud : </dt>
            <dd className="inline">{cloud.data?.name ?? '…'}</dd>
          </div>
          {h.technical_id && (
            <div>
              <dt className="inline text-slate-400">Identifiant technique : </dt>
              <dd className="inline font-mono">{h.technical_id}</dd>
            </div>
          )}
          <div>
            <dt className="inline text-slate-400">access.log : </dt>
            <dd className="inline font-mono">{h.access_log_path}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">Sonde : </dt>
            <dd className="inline">{h.probe_url ?? 'non configurée'}</dd>
          </div>
        </dl>
      </div>

      {/* État de l'agent */}
      <div className={card}>
        <h2 className="font-semibold">État de l'agent</h2>
        {!agentState.data && (
          <p className={`mt-1 ${mutedText}`}>
            Aucun heartbeat reçu. Générez le token puis installez l'agent sur cet hébergement (voir docs/setup.md).
          </p>
        )}
        {agentState.data && (
          <>
            <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {(
                [
                  ['Dernier heartbeat', formatRelativeTime(agentState.data.last_seen_at, now)],
                  ['Version de l’agent', agentState.data.agent_version ?? '—'],
                  ['Hostname vu par l’agent', agentState.data.hostname_seen ?? '—'],
                  ['Relevés en attente d’envoi', String(agentState.data.backlog ?? 0)],
                  ['Taille de l’access.log', formatBytes(agentState.data.log_size_bytes)],
                  ['Dernière erreur locale', agentState.data.last_error ?? 'aucune'],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3 border-b border-slate-100 pb-1 dark:border-slate-800">
                  <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {agentState.data.anomaly && (
              <p role="alert" className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                {ANOMALY_LABELS[agentState.data.anomaly] ?? `Anomalie : ${agentState.data.anomaly}`}
              </p>
            )}
          </>
        )}
        <p className={`mt-3 text-xs ${mutedText}`}>
          Les métriques CPU / RAM / load ne sont pas propres à l'hébergement : elles appartiennent à son Server Cloud.
        </p>
      </div>

      {/* Token d'agent */}
      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Token d'agent</h2>
            <p className={mutedText}>
              {h.token_active
                ? `Actif : ikh_${h.token_public_id}_… (généré ${h.token_rotated_at ? formatRelativeTime(h.token_rotated_at) : ''})`
                : h.token_public_id
                  ? 'Révoqué : aucun agent ne peut s’authentifier.'
                  : 'Aucun token généré.'}
            </p>
          </div>
          {canWrite && (
            <div className="flex gap-2">
              {h.token_active ? (
                <>
                  <button type="button" className={btn} onClick={() => setRotateOpen(true)}>
                    Régénérer
                  </button>
                  <button type="button" className={btnDanger} onClick={() => setRevokeOpen(true)}>
                    Révoquer
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={rotate.isPending}
                  onClick={() => rotate.mutate(0)}
                >
                  {rotate.isPending ? 'Génération…' : 'Générer le token'}
                </button>
              )}
              {h.is_active && !h.system_metrics_collector && (
                <button type="button" className={btn} disabled={collector.isPending} onClick={() => collector.mutate()}>
                  Définir comme collecteur
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-2">
          <ErrorNote error={rotate.error ?? collector.error} />
        </div>
      </div>

      {/* Sites */}
      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Sites / domaines</h2>
            <p className={mutedText}>
              {sites.data?.length ?? 0} domaine{(sites.data?.length ?? 0) > 1 ? 's' : ''}. Détectés automatiquement par
              l'agent à partir du dossier ~/sites de l'hébergement (au plus toutes les 6 h) ; l'import manuel permet
              de compléter (saisissez alors le nom tel qu'il apparaît dans les logs, avec « www. » si besoin).
            </p>
          </div>
          {canWrite && (
            <button type="button" className={btnPrimary} onClick={() => setImportOpen(true)}>
              Importer des domaines
            </button>
          )}
        </div>

        <ErrorNote error={sites.error ?? toggleSite.error} />

        {(sites.data?.length ?? 0) > 8 && (
          <input
            type="search"
            value={search}
            placeholder="Filtrer les domaines…"
            onChange={(e) => setSearch(e.target.value)}
            className={`${input} max-w-xs`}
          />
        )}

        {sites.data && sites.data.length === 0 && (
          <p className={`mt-4 ${mutedText}`}>Aucun domaine pour l'instant.</p>
        )}

        {filteredSites.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
            {filteredSites.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className={`font-mono ${s.is_active ? '' : 'text-slate-400 line-through'}`}>{s.domain}</span>
                <span className="flex items-center gap-3">
                  {s.source === 'discovered' && (
                    <span className="text-xs text-slate-400" title="Détecté dans le dossier ~/sites de l'hébergement">
                      auto
                    </span>
                  )}
                  {s.source === 'discovered' &&
                    s.last_seen_at &&
                    now - new Date(s.last_seen_at).getTime() > 48 * 3600 * 1000 && (
                      <span className="text-xs text-amber-700">
                        absent de ~/sites depuis {formatRelativeTime(s.last_seen_at, now).replace('il y a ', '')}
                      </span>
                    )}
                  {!s.is_verified && <span className="text-xs text-amber-700">non vérifié</span>}
                  {canWrite && (
                    <>
                      <button
                        type="button"
                        className="text-xs underline"
                        disabled={toggleSite.isPending}
                        onClick={() => toggleSite.mutate(s)}
                      >
                        {s.is_active ? 'Désactiver' : 'Réactiver'}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-red-600 underline"
                        onClick={() => setSiteToDelete(s)}
                      >
                        Supprimer
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`${card} border-dashed`}>
        <h2 className="font-semibold">Diagnostics de trafic</h2>
        <p className={mutedText}>Disponibles en phase 7 (analyse bornée de l'access.log pendant un incident).</p>
      </div>

      <HostingFormDialog open={editing} onClose={() => setEditing(false)} hosting={h} />
      <TokenRevealDialog token={revealedToken} hostingName={h.name} onClose={() => setRevealedToken(null)} />
      <RotateDialog
        open={rotateOpen}
        pending={rotate.isPending}
        error={rotate.error}
        onClose={() => setRotateOpen(false)}
        onConfirm={(grace) => rotate.mutate(grace)}
      />
      <ConfirmDialog
        open={revokeOpen}
        title="Révoquer le token ?"
        message="L'agent installé sur cet hébergement ne pourra plus envoyer de données tant qu'un nouveau token n'aura pas été généré et configuré."
        confirmLabel="Révoquer"
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoke.mutate()}
        onClose={() => setRevokeOpen(false)}
      />
      <ConfirmDialog
        open={deleting}
        title="Supprimer cet hébergement ?"
        message={`« ${h.name} », ses sites et son token seront supprimés définitivement.`}
        confirmLabel="Supprimer définitivement"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(false)}
      />
      <ConfirmDialog
        open={siteToDelete !== null}
        title="Supprimer ce domaine ?"
        message={siteToDelete ? `${siteToDelete.domain} sera retiré de l'inventaire.` : ''}
        confirmLabel="Supprimer"
        pending={removeSite.isPending}
        error={removeSite.error}
        onConfirm={() => siteToDelete && removeSite.mutate(siteToDelete)}
        onClose={() => setSiteToDelete(null)}
      />
      <ImportDialog
        open={importOpen}
        hostingId={h.id}
        onClose={() => setImportOpen(false)}
        onDone={async () => {
          await queryClient.invalidateQueries({ queryKey: ['sites', hostingId] })
          await queryClient.invalidateQueries({ queryKey: ['clouds'] })
          await queryClient.invalidateQueries({ queryKey: ['hostings'] })
        }}
      />
    </section>
  )
}

function RotateDialog(props: {
  open: boolean
  pending: boolean
  error: unknown
  onClose: () => void
  onConfirm: (graceMinutes: number) => void
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Régénérer le token">
      <RotateForm {...props} />
    </Dialog>
  )
}

function RotateForm({ pending, error, onClose, onConfirm }: Parameters<typeof RotateDialog>[0]) {
  const [grace, setGrace] = useState('1440')
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onConfirm(Number(grace))
      }}
      className="space-y-4"
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Un nouveau secret est généré. Choisissez ce qui arrive à l'ancien :
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="grace" value="1440" checked={grace === '1440'} onChange={() => setGrace('1440')} />
        <span>
          <strong>Rotation en douceur</strong> : l'ancien token reste valable 24 h, le temps de reconfigurer l'agent.
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="grace" value="0" checked={grace === '0'} onChange={() => setGrace('0')} />
        <span>
          <strong>Révocation immédiate</strong> de l'ancien (à choisir si le token a fuité).
        </span>
      </label>
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>
          Annuler
        </button>
        <button type="submit" className={btnPrimary} disabled={pending}>
          {pending ? 'Génération…' : 'Régénérer'}
        </button>
      </div>
    </form>
  )
}

function ImportDialog({
  open,
  hostingId,
  onClose,
  onDone,
}: {
  open: boolean
  hostingId: string
  onClose: () => void
  onDone: () => Promise<void>
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Importer des domaines">
      <ImportForm hostingId={hostingId} onClose={onClose} onDone={onDone} />
    </Dialog>
  )
}

function ImportForm({
  hostingId,
  onClose,
  onDone,
}: {
  hostingId: string
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<ImportSitesResult | null>(null)
  const mutation = useMutation({
    mutationFn: () => importSites(hostingId, text),
    onSuccess: async (res) => {
      setResult(res)
      await onDone()
    },
  })

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="space-y-4"
    >
      <label className="block text-sm font-medium">
        Un domaine par ligne
        <textarea
          rows={8}
          value={text}
          placeholder={'exemple.fr\nwww.autresite.com\nhttps://troisieme.fr/'}
          onChange={(e) => setText(e.target.value)}
          className={`${input} font-mono`}
        />
      </label>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Les schémas, chemins et ports sont retirés. Les doublons sont ignorés. Maximum 500 domaines par import.
      </p>
      {result && (
        <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800" role="status">
          <p>
            {result.inserted} ajouté{result.inserted > 1 ? 's' : ''} · {result.existing} déjà présent
            {result.existing > 1 ? 's' : ''} · {result.invalid.length} invalide{result.invalid.length > 1 ? 's' : ''}
          </p>
          {result.invalid.length > 0 && (
            <p className="mt-1 break-words font-mono text-xs text-red-600">{result.invalid.join(', ')}</p>
          )}
        </div>
      )}
      <ErrorNote error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>
          {result ? 'Fermer' : 'Annuler'}
        </button>
        <button type="submit" className={btnPrimary} disabled={mutation.isPending || !text.trim()}>
          {mutation.isPending ? 'Import…' : 'Importer'}
        </button>
      </div>
    </form>
  )
}
