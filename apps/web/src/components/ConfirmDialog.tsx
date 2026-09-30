import { btn, btnDanger } from './ui'
import { Dialog } from './Dialog'
import { ErrorNote } from './ErrorNote'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  pending?: boolean
  error?: unknown
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel, pending, error, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="text-sm text-slate-600 dark:text-slate-300">{message}</p>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>
          Annuler
        </button>
        <button type="button" className={btnDanger} disabled={pending} onClick={onConfirm}>
          {pending ? 'En cours…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
