import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="grid min-h-screen place-items-center px-4 text-center">
      <div>
        <p className="text-4xl font-semibold">404</p>
        <p className="mt-2 text-slate-500">Cette page n'existe pas.</p>
        <Link to="/" className="mt-4 inline-block text-sm font-medium underline">
          Retour au tableau de bord
        </Link>
      </div>
    </div>
  )
}
