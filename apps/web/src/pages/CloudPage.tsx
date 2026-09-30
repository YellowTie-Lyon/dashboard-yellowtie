import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ErrorNote } from '../components/ErrorNote'
import { StatusBadge } from '../components/StatusBadge'
import { btn, btnDanger, btnPrimary, card, mutedText } from '../components/ui'
import {
  deleteCloud,
  fetchCloud,
  fetchCloudStates,
  fetchHostingStates,
  fetchHostings,
  setSystemCollector,
  sitesCount,
} from '../features/inventory/api'
import { CloudFormDialog } from '../features/inventory/CloudFormDialog'
import { HostingFormDialog } from '../features/inventory/HostingFormDialog'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { MetricsCard } from '../components/MetricsCard'
import { formatRelativeTime } from '../lib/format'
import { LIVE } from '../lib/live'
import { useNow } from '../lib/useNow'

// Les graphiques (Recharts) sont chargés à la demande : la page de connexion et le tableau de bord restent légers.
const MetricsCharts = lazy(() => import('../features/metrics/MetricsCharts').then((m) => ({ default: m.MetricsCharts })))

export function CloudPage() {
  const { cloudId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { workspace, canWrite } = useWorkspace()

  const cloud = useQuery({ queryKey: ['cloud', cloudId], queryFn: () => fetchCloud(cloudId), refetchInterval: LIVE.slow })
  const hostings = useQuery({ queryKey: ['hostings', cloudId], queryFn: () => fetchHostings(cloudId), refetchInterval: LIVE.slow })
  const hostingIds = (hostings.data ?? []).map((h) => h.id)
  const hostingStates = useQuery({
    queryKey: ['hosting-states', cloudId, hostingIds],
    queryFn: () => fetchHostingStates(hostingIds),
    enabled: hostings.isSuccess,
    refetchInterval: LIVE.fast,
  })
  const cloudStates = useQuery({ queryKey: ['cloud-states'], queryFn: fetchCloudStates, refetchInterval: LIVE.fast })
  const now = useNow()

  const [editing, setEditing] = useState(false)
  const [addingHosting, setAddingHosting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const remove = useMutation({
    mutationFn: () => deleteCloud(cloudId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clouds'] })
      void navigate('/', { replace: true })
    },
  })

  const collector = useMutation({
    mutationFn: setSystemCollector,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hostings', cloudId] }),
  })

  if (cloud.isPending) return <p className={mutedText}>Chargement…</p>
  if (cloud.error) return <ErrorNote error={cloud.error} />
  if (!cloud.data) {
    return (
      <div>
        <p className="font-medium">Server Cloud introuvable.</p>
        <Link to="/" className="text-sm underline">
          Retour
        </Link>
      </div>
    )
  }

  const c = cloud.data
  const rows = hostings.data ?? []
  const seenById = new Map((hostingStates.data ?? []).map((st) => [st.web_hosting_id, st]))
  const cloudState = (cloudStates.data ?? []).find((st) => st.cloud_server_id === c.id) ?? null
  const hasCollector = rows.some((h) => h.system_metrics_collector && h.is_active)

  return (
    <section className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-slate-500 hover:underline dark:text-slate-400">
          ← Server Clouds
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold uppercase tracking-tight">{c.name}</h1>
            <StatusBadge status={cloudState ? 'observing' : 'unknown'} />
            {c.maintenance && (
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Maintenance
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
            <dt className="inline text-slate-400">Identifiant : </dt>
            <dd className="inline font-mono">{c.slug}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">vCPU : </dt>
            <dd className="inline">{c.cpu_cores ?? 'non renseigné'}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">Offline après : </dt>
            <dd className="inline">{c.offline_after_seconds} s</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">Hostname : </dt>
            <dd className="inline font-mono">{c.hostname ?? 'appris par l’agent'}</dd>
          </div>
          <div>
            <dt className="inline text-slate-400">Créé : </dt>
            <dd className="inline">{formatRelativeTime(c.created_at)}</dd>
          </div>
        </dl>
        {c.notes && <p className={`mt-2 ${mutedText}`}>{c.notes}</p>}
      </div>

      <MetricsCard state={cloudState} offlineAfterSeconds={c.offline_after_seconds} now={now} />

      <Suspense fallback={<p className={mutedText}>Chargement des graphiques…</p>}>
        <MetricsCharts cloud={c} />
      </Suspense>

      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Hébergements</h2>
            <p className={mutedText}>
              {rows.length} hébergement{rows.length > 1 ? 's' : ''} · {sitesCount(rows)} site
              {sitesCount(rows) > 1 ? 's' : ''}
            </p>
          </div>
          {canWrite && (
            <button type="button" className={btnPrimary} onClick={() => setAddingHosting(true)}>
              + Ajouter un hébergement
            </button>
          )}
        </div>

        {rows.length > 0 && !hasCollector && (
          <p role="alert" className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Aucun collecteur système actif sur ce Cloud : désignez un hébergement pour remonter load, CPU, RAM
            et disque.
          </p>
        )}
        <ErrorNote error={hostings.error ?? collector.error} />

        {rows.length === 0 && hostings.data && (
          <p className={`mt-4 ${mutedText}`}>Aucun hébergement. Ajoutez-en un pour générer son token d'agent.</p>
        )}

        {rows.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-200 dark:divide-slate-800">
            {rows.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link to={`/hostings/${h.id}`} className="font-medium hover:underline">
                    {h.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    {h.system_metrics_collector && (
                      <span className="rounded-full bg-yellow-100 px-2 py-0.5 font-medium text-yellow-900 dark:bg-yellow-950 dark:text-yellow-300">
                        Collecteur système
                      </span>
                    )}
                    {!h.is_active && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        Inactif
                      </span>
                    )}
                    <span className="text-slate-500 dark:text-slate-400">
                      {h.token_active ? `Token actif (ikh_${h.token_public_id}…)` : 'Aucun token actif'}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">
                      · {h.sites[0]?.count ?? 0} site{(h.sites[0]?.count ?? 0) > 1 ? 's' : ''}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">
                      ·{' '}
                      {seenById.get(h.id)
                        ? `agent vu ${formatRelativeTime(seenById.get(h.id)!.last_seen_at, now)}`
                        : 'aucun heartbeat reçu'}
                    </span>
                    {seenById.get(h.id)?.anomaly && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        Anomalie
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  {canWrite && !h.system_metrics_collector && h.is_active && (
                    <button
                      type="button"
                      className={btn}
                      disabled={collector.isPending}
                      onClick={() => collector.mutate(h.id)}
                    >
                      Définir comme collecteur
                    </button>
                  )}
                  <Link to={`/hostings/${h.id}`} className={btn}>
                    Ouvrir
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`${card} border-dashed`}>
        <h2 className="font-semibold">Incidents et diagnostics de trafic</h2>
        <p className={mutedText}>Disponibles en phases 6 et 7.</p>
      </div>

      {workspace && (
        <CloudFormDialog open={editing} onClose={() => setEditing(false)} workspaceId={workspace.id} cloud={c} />
      )}
      <HostingFormDialog open={addingHosting} onClose={() => setAddingHosting(false)} cloudId={c.id} />
      <ConfirmDialog
        open={deleting}
        title="Supprimer ce Server Cloud ?"
        message={`« ${c.name} », ses hébergements, leurs sites et leurs tokens seront supprimés définitivement. Les agents déjà installés cesseront d'être acceptés.`}
        confirmLabel="Supprimer définitivement"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(false)}
      />
    </section>
  )
}
