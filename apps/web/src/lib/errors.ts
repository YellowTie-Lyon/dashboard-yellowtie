/** Traduit une erreur PostgREST / Postgres en message lisible. */
export function errorMessage(error: unknown): string {
  const e = error as { code?: string; message?: string } | null
  switch (e?.code) {
    case '42501':
      return 'Action non autorisée : le rôle propriétaire est requis.'
    case '23505':
      return 'Cet élément existe déjà (nom ou identifiant déjà utilisé).'
    case '23514':
      if (e.message === 'last owner') return 'Il doit toujours rester au moins un propriétaire.'
      return "Une valeur est invalide (vérifiez les formats, l'URL de sonde doit être en HTTPS)."
    case '22023':
      return e.message ?? 'Paramètre invalide.'
    default:
      return e?.message ?? 'Erreur inattendue.'
  }
}
