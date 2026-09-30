import { useState } from 'react'
import { agentInstallCommand } from '../lib/agentCommand'
import { Dialog } from './Dialog'
import { btn, btnPrimary, input } from './ui'

interface TokenRevealDialogProps {
  /** Token en clair, ou null si aucun n'est à afficher. À vider dès la fermeture. */
  token: string | null
  hostingName: string
  onClose: () => void
}

/** Affiche le secret UNE seule fois. Le token n'est stocké nulle part côté client au-delà de cet état. */
export function TokenRevealDialog({ token, hostingName, onClose }: TokenRevealDialogProps) {
  const [copied, setCopied] = useState<'token' | 'command' | null>(null)

  const command = agentInstallCommand()

  async function copy(kind: 'token' | 'command') {
    try {
      await navigator.clipboard.writeText(kind === 'token' ? (token ?? '') : command)
      setCopied(kind)
    } catch {
      setCopied(null)
    }
  }

  return (
    <Dialog open={token !== null} onClose={onClose} title={`Token de l'hébergement ${hostingName}`}>
      <p className="text-sm text-amber-700 dark:text-amber-400">
        Copiez ce token maintenant : <strong>il ne sera plus jamais affiché</strong>. Seule son empreinte est
        conservée. En cas de perte, régénérez-en un.
      </p>
      <label className="mt-4 block text-sm font-medium">
        Token d'agent
        <input
          readOnly
          value={token ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          className={`${input} font-mono text-xs`}
        />
      </label>
      <div className="mt-2 flex justify-end">
        <button type="button" className={btn} onClick={() => void copy('token')}>
          {copied === 'token' ? 'Token copié ✓' : 'Copier le token'}
        </button>
      </div>

      <div className="mt-4 rounded-md bg-slate-50 p-3 dark:bg-slate-800">
        <p className="text-sm font-medium">Installation sur l'hébergement (en SSH)</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs">{command}</pre>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          L'installeur demande ensuite le token (saisie masquée) : collez-le à ce moment-là. Ne le collez jamais
          dans un dépôt Git, un ticket ou une conversation.
        </p>
        <div className="mt-2 flex justify-end">
          <button type="button" className={btn} onClick={() => void copy('command')}>
            {copied === 'command' ? 'Commande copiée ✓' : 'Copier la commande'}
          </button>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btnPrimary} onClick={onClose}>
          J'ai copié le token
        </button>
      </div>
    </Dialog>
  )
}
