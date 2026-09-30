import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Dialog } from '../../components/Dialog'
import { ErrorNote } from '../../components/ErrorNote'
import { btn, btnPrimary, input } from '../../components/ui'
import type { WebHosting } from '../../lib/types'
import { createHosting, updateHosting } from './api'

interface Props {
  open: boolean
  onClose: () => void
  /** Création : Server Cloud parent. */
  cloudId?: string
  /** Édition. */
  hosting?: WebHosting
}

export function HostingFormDialog({ open, onClose, cloudId, hosting }: Props) {
  return (
    <Dialog open={open} onClose={onClose} title={hosting ? "Modifier l'hébergement" : 'Nouvel hébergement'}>
      <HostingForm cloudId={cloudId} hosting={hosting} onClose={onClose} />
    </Dialog>
  )
}

function HostingForm({ cloudId, hosting, onClose }: Omit<Props, 'open'>) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(hosting?.name ?? '')
  const [technicalId, setTechnicalId] = useState(hosting?.technical_id ?? '')
  const [logPath, setLogPath] = useState(hosting?.access_log_path ?? '~/ik-logs/access.log')
  const [probeUrl, setProbeUrl] = useState(hosting?.probe_url ?? '')
  const [isActive, setIsActive] = useState(hosting?.is_active ?? true)

  const mutation = useMutation({
    mutationFn: async () => {
      const base = {
        name: name.trim(),
        technical_id: technicalId.trim() || null,
        access_log_path: logPath.trim(),
        probe_url: probeUrl.trim() || null,
      }
      if (hosting) await updateHosting(hosting.id, { ...base, is_active: isActive })
      else if (cloudId) await createHosting(cloudId, base)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['hostings'] })
      await queryClient.invalidateQueries({ queryKey: ['hosting'] })
      await queryClient.invalidateQueries({ queryKey: ['clouds'] })
      onClose()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm font-medium">
        Nom
        <input
          required
          maxLength={100}
          value={name}
          placeholder="Web-Cloud-YellowTie-1"
          onChange={(e) => setName(e.target.value)}
          className={input}
        />
      </label>
      <label className="block text-sm font-medium">
        Identifiant technique (optionnel)
        <input
          maxLength={100}
          value={technicalId}
          onChange={(e) => setTechnicalId(e.target.value)}
          className={input}
        />
      </label>
      <label className="block text-sm font-medium">
        Chemin de l'access.log
        <input
          required
          maxLength={255}
          value={logPath}
          onChange={(e) => setLogPath(e.target.value)}
          className={`${input} font-mono`}
        />
      </label>
      <label className="block text-sm font-medium">
        URL de sonde (HTTPS, optionnelle)
        <input
          type="url"
          pattern="https://.*"
          value={probeUrl}
          placeholder="https://exemple.fr/ik-probe.txt"
          onChange={(e) => setProbeUrl(e.target.value)}
          className={input}
        />
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          Conseillé : un petit fichier statique d'un site de cet hébergement, pour ne pas solliciter PHP.
        </span>
      </label>
      {hosting && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Hébergement actif
        </label>
      )}
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
