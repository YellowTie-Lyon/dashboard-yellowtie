import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { StatusBadge } from '../components/StatusBadge'
import { btnPrimary, card, mutedText } from '../components/ui'
import { fetchCloudStates, fetchClouds, sitesCount } from '../features/inventory/api'
import { CloudFormDialog } from '../features/inventory/CloudFormDialog'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { errorMessage } from '../lib/errors'
import { formatLoad, formatPercent, formatRelativeTime } from '../lib/format'
import type { CloudState, CloudWithCounts } from '../lib/types'
import { useNow } from '../lib/useNow'

export function DashboardPage() {
  const navigate = useNavigate()
  const { workspace, canWrite, isPending: workspacePending, error: workspaceError } = useWorkspace()
  const clouds = useQuery({ queryKey: ['clouds'], queryFn: fetchClouds })
  const states = useQuery({ queryKey: ['cloud-states'], queryFn: fetchCloudStates, refetchInterval: 30_000 })
  const now = useNow()
  const stateByCloud = new Map((states.data ?? []).map((st) => [st.cloud_server_id, st]))
  const [creating, setCreating] = useState(false)

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Server Clouds</h1>
          <p className={mutedText}>
            {workspacePending && 'Chargement du workspace…'}
            {workspaceError && 'Impossible de lire le workspace.'}
            {workspace && <>Workspace : {workspace.name}</>}
            {!workspacePending && !workspaceError && !workspace && (
              <>Ce compte n'est rattaché à aucun workspace (voir docs/setup.md).</>
            )}
          </p>
        </div>
        {canWrite && workspace && (
          <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
            + Ajouter un Server Cloud
          </button>
        )}
      </div>

      {clouds.error && (
        <p role="alert" className="text-sm text-red-600">
          {errorMessage(clouds.error)}
        </p>
      )}
      {clouds.isPending && <p className={mutedText}>Chargement…</p>}

      {clouds.data && clouds.data.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <p className="font-medium">Aucun Server Cloud configuré</p>
          <p className={`mt-1 ${mutedText}`}>
            Ajoutez vos Server Clouds, puis leurs hébergements, pour préparer l'installation des agents.
          </p>
        </div>
      )}

      {clouds.data && clouds.data.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clouds.data.map((cloud) => (
            <CloudCard key={cloud.id} cloud={cloud} state={stateByCloud.get(cloud.id)} now={now} />
          ))}
        </ul>
      )}

      {workspace && (
        <CloudFormDialog
          open={creating}
          onClose={() => setCreating(false)}
          workspaceId={workspace.id}
          onCreated={(created) => void navigate(`/clouds/${created.id}`)}
        />
      )}
    </section>
  )
}

function CloudCard({ cloud, state, now }: { cloud: CloudWithCounts; state?: CloudState; now: number }) {
  const hostings = cloud.web_hostings.length
  const sites = sitesCount(cloud.web_hostings)
  const point = state?.last_point
  const stale = state ? (now - new Date(state.last_received_at).getTime()) / 1000 > cloud.offline_after_seconds : false
  const metrics: [string, string][] = [
    ['CPU', formatPercent(point?.cpu_pct)],
    ['Load 1m', formatLoad(point?.load1)],
    ['RAM', formatPercent(point?.mem_used_pct)],
    ['Disque', formatPercent(point?.disk_used_pct)],
  ]
  return (
    <li>
      <Link to={`/clouds/${cloud.id}`} className={`${card} block transition hover:border-yellow-400`}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold uppercase tracking-tight">{cloud.name}</h2>
          <StatusBadge status={state ? 'observing' : 'unknown'} />
        </div>
        <dl className={`mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm ${stale ? 'opacity-60' : ''}`}>
          {metrics.map(([label, value]) => (
            <div key={label} className="flex justify-between">
              <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          {hostings} hébergement{hostings > 1 ? 's' : ''} · {sites} site{sites > 1 ? 's' : ''}
          {cloud.cpu_cores ? ` · ${cloud.cpu_cores} vCPU` : ''}
        </p>
        <p className={`mt-1 text-xs ${stale ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-slate-400'}`}>
          {state
            ? `Dernière donnée : ${formatRelativeTime(state.last_received_at, now)}${stale ? ' · silence prolongé' : ''}`
            : 'Dernière donnée : aucune (agents non installés)'}
        </p>
        {cloud.maintenance && (
          <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">Mode maintenance</p>
        )}
      </Link>
    </li>
  )
}
