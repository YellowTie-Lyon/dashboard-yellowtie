import { useState } from 'react'
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
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (!token) return
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setCopied(false)
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
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Il sera saisi lors de l'installation de l'agent sur cet hébergement (l'installeur arrive en phase 3).
        Ne le collez jamais dans un dépôt Git, un ticket ou une conversation.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn} onClick={() => void copy()}>
          {copied ? 'Copié ✓' : 'Copier'}
        </button>
        <button type="button" className={btnPrimary} onClick={onClose}>
          J'ai copié le token
        </button>
      </div>
    </Dialog>
  )
}
