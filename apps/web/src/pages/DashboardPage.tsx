import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { btnPrimary, mutedText } from '../components/ui'
import { fetchCloudStatuses } from '../features/alerts/api'
import { CloudPanel } from '../features/dashboard/CloudPanel'
import { fetchIncidents } from '../features/incidents/api'
import { isOpen } from '../lib/incidents'
import { fetchHostingStates, fetchCloudStates, fetchClouds, sitesCount } from '../features/inventory/api'
import { CloudFormDialog } from '../features/inventory/CloudFormDialog'
import { useWorkspace } from '../features/workspace/useWorkspace'
import { errorMessage } from '../lib/errors'
import { LIVE } from '../lib/live'
import type { CloudStatusRow, CloudWithCounts, Incident } from '../lib/types'
import { useNow } from '../lib/useNow'

export function DashboardPage() {
  const navigate = useNavigate()
  const { workspace, canWrite, isPending: workspacePending, error: workspaceError } = useWorkspace()
  const clouds = useQuery({ queryKey: ['clouds'], queryFn: fetchClouds, refetchInterval: LIVE.slow })
  const states = useQuery({ queryKey: ['cloud-states'], queryFn: fetchCloudStates, refetchInterval: LIVE.fast })
  const statuses = useQuery({ queryKey: ['cloud-statuses'], queryFn: fetchCloudStatuses, refetchInterval: LIVE.fast })
  const statusByCloud = new Map((statuses.data ?? []).map((st) => [st.cloud_server_id, st]))
  const now = useNow()
  const hostingIds = (clouds.data ?? []).flatMap((c) => c.web_hostings.map((h) => h.id))
  const hostingStates = useQuery({
    queryKey: ['hosting-states', 'all', hostingIds],
    queryFn: () => fetchHostingStates(hostingIds),
    enabled: clouds.isSuccess,
    refetchInterval: LIVE.fast,
  })
  const hostingStateById = new Map((hostingStates.data ?? []).map((h) => [h.web_hosting_id, h]))
  const incidents = useQuery({ queryKey: ['incidents', 'open-list'], queryFn: () => fetchIncidents({ limit: 100 }), refetchInterval: LIVE.fast })
  const openIncidents = (incidents.data ?? []).filter(isOpen)
  const stateByCloud = new Map((states.data ?? []).map((st) => [st.cloud_server_id, st]))
  const [creating, setCreating] = useState(false)

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Vue d'ensemble</h1>
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
        <>
          <SummaryStrip clouds={clouds.data} statuses={statusByCloud} openIncidents={openIncidents} />
          <div className="grid gap-6 2xl:grid-cols-2">
            {clouds.data.map((cloud) => (
              <CloudPanel
                key={cloud.id}
                cloud={cloud}
                state={stateByCloud.get(cloud.id)}
                status={statusByCloud.get(cloud.id)}
                hostingNames={new Map(cloud.web_hostings.map((h) => [h.id, h.name]))}
                hostingStates={hostingStateById}
                openIncidents={openIncidents.filter((i) => i.cloud_server_id === cloud.id)}
                now={now}
              />
            ))}
          </div>
        </>
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

function SummaryStrip({
  clouds,
  statuses,
  openIncidents,
}: {
  clouds: CloudWithCounts[]
  statuses: Map<string, CloudStatusRow>
  openIncidents: Incident[]
}) {
  const count = (pred: (s: string) => boolean) => clouds.filter((c) => pred(statuses.get(c.id)?.status ?? 'unknown')).length
  const problems = count((s) => s === 'warning' || s === 'critical' || s === 'offline')
  const items: [string, string, boolean][] = [
    ['Server Clouds', String(clouds.length), false],
    ['En alerte', String(problems), problems > 0],
    ['Incidents en cours', String(openIncidents.length), openIncidents.length > 0],
    ['Hébergements', String(clouds.reduce((n, c) => n + c.web_hostings.length, 0)), false],
    ['Sites', String(clouds.reduce((n, c) => n + sitesCount(c.web_hostings), 0)), false],
  ]
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([label, value, alert]) => (
        <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
          <dt className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</dt>
          <dd className={`text-2xl font-bold tabular-nums ${alert ? 'text-red-400' : 'text-yellow-400'}`}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
