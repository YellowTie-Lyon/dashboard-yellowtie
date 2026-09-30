import { useState } from 'react'
import { agentInstallCommand } from '../lib/agentCommand'
import { Dialog } from './Dialog'
import { btn, btnPrimary } from './ui'

/** Commande pour mettre à jour l'agent d'un hébergement SANS régénérer son token (Entrée conserve le token en place). */
export function UpdateAgentDialog({ open, hostingName, onClose }: { open: boolean; hostingName: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const command = agentInstallCommand()

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Mettre à jour l'agent de ${hostingName}`}>
      <p className="text-sm">
        Le token actuel reste valable : <strong>rien n'est régénéré</strong>. Connectez-vous en SSH à cet hébergement, collez les deux
        lignes, puis appuyez sur <strong>Entrée</strong> quand l'installeur demande le token.
      </p>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-slate-50 p-3 text-xs dark:bg-white/5">{command}</pre>
      <div className="mt-2 flex justify-end">
        <button type="button" className={btn} onClick={() => void copy()}>
          {copied ? 'Commande copiée ✓' : 'Copier la commande'}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Vérification : <code className="font-mono">~/.ik-monitor/ik-agent.sh --version</code> affiche la version installée.
        L'installeur remplace l'agent, vérifie sa somme de contrôle et garde la configuration et la ligne de cron.
      </p>
      <div className="mt-5 flex justify-end">
        <button type="button" className={btnPrimary} onClick={onClose}>
          Fermer
        </button>
      </div>
    </Dialog>
  )
}
