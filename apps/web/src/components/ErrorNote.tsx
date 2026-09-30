import { errorMessage } from '../lib/errors'

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {errorMessage(error)}
    </p>
  )
}
