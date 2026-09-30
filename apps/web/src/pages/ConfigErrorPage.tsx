export function ConfigErrorPage() {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="max-w-md rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <p className="font-semibold">Configuration manquante</p>
        <p className="mt-2">
          Les variables <code>VITE_SUPABASE_URL</code> et <code>VITE_SUPABASE_ANON_KEY</code> ne sont
          pas définies. Renseignez-les dans Netlify (ou dans un fichier <code>.env.local</code> en
          développement), puis redéployez.
        </p>
      </div>
    </div>
  )
}
