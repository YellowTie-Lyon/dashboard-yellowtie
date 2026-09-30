import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { card, input, mutedText } from '../components/ui'
import { ErrorNote } from '../components/ErrorNote'
import { fetchIncidents } from '../features/incidents/api'
import { IncidentsList } from '../features/incidents/IncidentsList'
import { isOpen, KIND_LABELS } from '../lib/incidents'
import { LIVE } from '../lib/live'
import type { IncidentKind } from '../lib/types'
import { useNow } from '../lib/useNow'

type StatusFilter = 'all' | 'open' | 'closed'

export function IncidentsPage() {
  const incidents = useQuery({ queryKey: ['incidents', 'all'], queryFn: () => fetchIncidents({ limit: 300 }), refetchInterval: LIVE.fast })
  const now = useNow(15_000)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [kind, setKind] = useState<'all' | IncidentKind>('all')
  const [cloud, setCloud] = useState('all')

  const clouds = useMemo(() => {
    const names = new Map<string, string>()
    for (const i of incidents.data ?? []) if (i.cloud_servers) names.set(i.cloud_server_id, i.cloud_servers.name)
    return [...names.entries()]
  }, [incidents.data])

  const filtered = (incidents.data ?? []).filter(
    (i) =>
      (status === 'all' || (status === 'open' ? isOpen(i) : !isOpen(i))) &&
      (kind === 'all' || i.kind === kind) &&
      (cloud === 'all' || i.cloud_server_id === cloud),
  )
  const openCount = (incidents.data ?? []).filter(isOpen).length

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
        <p className={mutedText}>
          Historique des périodes où un Server Cloud est sorti de l'état normal. {openCount > 0 ? `${openCount} en cours.` : 'Aucun incident en cours.'}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium">
          État
          <select className={`${input} mt-1 w-auto`} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="all">Tous</option>
            <option value="open">En cours</option>
            <option value="closed">Clos</option>
          </select>
        </label>
        <label className="text-sm font-medium">
          Type
          <select className={`${input} mt-1 w-auto`} value={kind} onChange={(e) => setKind(e.target.value as 'all' | IncidentKind)}>
            <option value="all">Tous</option>
            {(Object.keys(KIND_LABELS) as IncidentKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {clouds.length > 1 && (
          <label className="text-sm font-medium">
            Server Cloud
            <select className={`${input} mt-1 w-auto`} value={cloud} onChange={(e) => setCloud(e.target.value)}>
              <option value="all">Tous</option>
              {clouds.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ErrorNote error={incidents.error} />
      {incidents.isPending && <p className={mutedText}>Chargement…</p>}

      {incidents.data && (
        <div className={card}>
          {filtered.length === 0 ? (
            <p className={mutedText}>
              {incidents.data.length === 0
                ? "Aucun incident enregistré pour l'instant. Un incident s'ouvre dès qu'un Server Cloud dépasse un seuil ou cesse d'envoyer des données."
                : 'Aucun incident ne correspond à ces filtres.'}
            </p>
          ) : (
            <IncidentsList incidents={filtered} now={now} />
          )}
        </div>
      )}
    </section>
  )
}
