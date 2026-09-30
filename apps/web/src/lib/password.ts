// Alphabet sans caractères ambigus (0/O, 1/l/I) : le mot de passe se lit et se recopie sans erreur.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const SYMBOLS = '-_.!'

/** Mot de passe aléatoire (générateur cryptographique du navigateur), 16 caractères par défaut. */
export function generatePassword(length = 16): string {
  const pool = ALPHABET + SYMBOLS
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  // Rejet des valeurs qui fausseraient la répartition (biais du modulo).
  const limit = Math.floor(0x100000000 / pool.length) * pool.length
  let out = ''
  for (let i = 0; i < length; i++) {
    let v = bytes[i]!
    while (v >= limit) v = crypto.getRandomValues(new Uint32Array(1))[0]!
    out += pool[v % pool.length]
  }
  return out
}
