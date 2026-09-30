import { useQuery } from '@tanstack/react-query'
import { fetchCloudStatuses } from '../alerts/api'
import { fetchIncidents } from '../incidents/api'
import { fetchCloudStates, fetchClouds, fetchHostingStates } from '../inventory/api'
import { isOpen } from '../../lib/incidents'
import { LIVE } from '../../lib/live'
import { useNow } from '../../lib/useNow'

/** Données de la vue d'ensemble (partagées par la page d'accueil et le mode TV : mêmes requêtes, donc même cache). */
export function useDashboardData() {
  const clouds = useQuery({ queryKey: ['clouds'], queryFn: fetchClouds, refetchInterval: LIVE.slow })
  const states = useQuery({ queryKey: ['cloud-states'], queryFn: fetchCloudStates, refetchInterval: LIVE.fast })
  const statuses = useQuery({ queryKey: ['cloud-statuses'], queryFn: fetchCloudStatuses, refetchInterval: LIVE.fast })
  const hostingIds = (clouds.data ?? []).flatMap((c) => c.web_hostings.map((h) => h.id))
  const hostingStates = useQuery({
    queryKey: ['hosting-states', 'all', hostingIds],
    queryFn: () => fetchHostingStates(hostingIds),
    enabled: clouds.isSuccess,
    refetchInterval: LIVE.fast,
  })
  const incidents = useQuery({ queryKey: ['incidents', 'open-list'], queryFn: () => fetchIncidents({ limit: 100 }), refetchInterval: LIVE.fast })
  const now = useNow()
  return {
    clouds,
    now,
    statusByCloud: new Map((statuses.data ?? []).map((st) => [st.cloud_server_id, st])),
    stateByCloud: new Map((states.data ?? []).map((st) => [st.cloud_server_id, st])),
    hostingStateById: new Map((hostingStates.data ?? []).map((h) => [h.web_hosting_id, h])),
    openIncidents: (incidents.data ?? []).filter(isOpen),
  }
}
