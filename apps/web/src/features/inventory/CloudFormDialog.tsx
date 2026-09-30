import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Dialog } from '../../components/Dialog'
import { ErrorNote } from '../../components/ErrorNote'
import { btn, btnPrimary, input } from '../../components/ui'
import { slugify } from '../../lib/slug'
import type { CloudServer } from '../../lib/types'
import { createCloud, updateCloud, type CloudInput } from './api'

interface Props {
  open: boolean
  onClose: () => void
  workspaceId: string
  /** Fourni : mode édition. Absent : mode création. */
  cloud?: CloudServer
  onCreated?: (cloud: CloudServer) => void
}

export function CloudFormDialog({ open, onClose, workspaceId, cloud, onCreated }: Props) {
  return (
    <Dialog open={open} onClose={onClose} title={cloud ? 'Modifier le Server Cloud' : 'Nouveau Server Cloud'}>
      <CloudForm workspaceId={workspaceId} cloud={cloud} onClose={onClose} onCreated={onCreated} />
    </Dialog>
  )
}

function CloudForm({ workspaceId, cloud, onClose, onCreated }: Omit<Props, 'open'>) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(cloud?.name ?? '')
  const [slug, setSlug] = useState(cloud?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(Boolean(cloud))
  const [cores, setCores] = useState(cloud?.cpu_cores?.toString() ?? '')
  const [offlineAfter, setOfflineAfter] = useState((cloud?.offline_after_seconds ?? 240).toString())
  const [maintenance, setMaintenance] = useState(cloud?.maintenance ?? false)
  const [notes, setNotes] = useState(cloud?.notes ?? '')

  const mutation = useMutation({
    mutationFn: async (payload: CloudInput) =>
      cloud ? (await updateCloud(cloud.id, payload), null) : createCloud(workspaceId, payload),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['clouds'] })
      if (cloud) await queryClient.invalidateQueries({ queryKey: ['cloud', cloud.id] })
      if (created) onCreated?.(created)
      onClose()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate({
      name: name.trim(),
      slug,
      cpu_cores: cores ? Number(cores) : null,
      offline_after_seconds: Number(offlineAfter),
      maintenance,
      notes: notes.trim() || null,
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm font-medium">
        Nom
        <input
          required
          maxLength={100}
          value={name}
          placeholder="YellowTie Server Cloud 1"
          onChange={(e) => {
            setName(e.target.value)
            if (!slugTouched) setSlug(slugify(e.target.value))
          }}
          className={input}
        />
      </label>
      <label className="block text-sm font-medium">
        Identifiant (slug)
        <input
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={60}
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value)
            setSlugTouched(true)
          }}
          className={`${input} font-mono`}
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm font-medium">
          Cœurs (vCPU)
          <input
            type="number"
            min={1}
            max={512}
            value={cores}
            placeholder="12"
            onChange={(e) => setCores(e.target.value)}
            className={input}
          />
        </label>
        <label className="block text-sm font-medium">
          Seuil offline (secondes)
          <input
            required
            type="number"
            min={60}
            max={3600}
            value={offlineAfter}
            onChange={(e) => setOfflineAfter(e.target.value)}
            className={input}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={maintenance} onChange={(e) => setMaintenance(e.target.checked)} />
        Mode maintenance (aucune alerte)
      </label>
      <label className="block text-sm font-medium">
        Notes
        <textarea
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={input}
        />
      </label>
      <ErrorNote error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>
          Annuler
        </button>
        <button type="submit" className={btnPrimary} disabled={mutation.isPending}>
          {mutation.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </form>
  )
}
