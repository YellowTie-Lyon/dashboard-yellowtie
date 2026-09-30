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

/** Message clair pour une erreur de double authentification (le code d'erreur Supabase guide le diagnostic). */
export function mfaErrorMessage(error: unknown): string {
  const e = error as { code?: string; message?: string; status?: number } | null
  switch (e?.code) {
    case 'mfa_verification_failed':
      return 'Code incorrect. Saisissez le code actuel de l’application (il change toutes les 30 secondes) et vérifiez l’heure de votre téléphone.'
    case 'mfa_challenge_expired':
      return 'Le code a expiré. Saisissez le nouveau code affiché.'
    case 'mfa_totp_verify_not_enabled':
    case 'mfa_totp_enroll_not_enabled':
      return 'La double authentification par application n’est pas activée sur le projet Supabase (Authentication > Multi-Factor > TOTP).'
    case 'over_request_rate_limit':
      return 'Trop de tentatives. Patientez une minute puis réessayez.'
    default:
      return `Vérification impossible${e?.message ? ` : ${e.message}` : '.'}`
  }
}
