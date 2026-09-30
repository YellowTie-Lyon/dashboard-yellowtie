/** "il y a 32 s", "il y a 4 min", "il y a 2 h", "il y a 3 j". */
export function formatRelativeTime(from: Date | string | number, now: number = Date.now()): string {
  const seconds = Math.floor((now - new Date(from).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 5) return "à l'instant"
  if (seconds < 60) return `il y a ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `il y a ${hours} h`
  return `il y a ${Math.floor(hours / 24)} j`
}

/** Durée lisible pour un incident : "45 s", "17 min", "2 h 05". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
}
