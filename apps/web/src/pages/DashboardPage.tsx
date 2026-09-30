import { useQuery } from '@tanstack/react-query'
import { StatusBadge } from '../components/StatusBadge'
import { getSupabase } from '../lib/supabase'

interface Workspace {
  id: string
  name: string
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  const { data, error } = await getSupabase().from('workspaces').select('id, name').order('created_at')
  if (error) throw error
  return data
}

export function DashboardPage() {
  const { data, isPending, error } = useQuery({ queryKey: ['workspaces'], queryFn: fetchWorkspaces })

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Server Clouds</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {isPending && 'Chargement du workspace…'}
          {error && 'Impossible de lire le workspace.'}
          {data && data.length > 0 && <>Workspace : {data[0]?.name}</>}
          {data && data.length === 0 && (
            <>Ce compte n'est rattaché à aucun workspace (voir docs/setup.md).</>
          )}
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
        <p className="font-medium">Aucun Server Cloud configuré</p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          La gestion des Server Clouds et des hébergements arrive en phase 2.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Aperçu des statuts">
          <StatusBadge status="normal" />
          <StatusBadge status="warning" />
          <StatusBadge status="critical" />
          <StatusBadge status="offline" />
        </div>
      </div>
    </section>
  )
}
