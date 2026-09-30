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

const fr1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const fr2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 32,4 % ; « — » si la valeur n'existe pas (ex. CPU non calculable au premier relevé). */
export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${fr1.format(value)} %`
}

/** Load average : 2 décimales, « 0,62 ». */
export function formatLoad(value: number | null | undefined): string {
  return value == null ? '—' : fr2.format(value)
}

/** 512 Mo · 35,2 Go · 1,2 To (entrée en Mo). */
export function formatMb(mb: number | null | undefined): string {
  if (mb == null) return '—'
  if (mb < 1024) return `${fr1.format(mb)} Mo`
  if (mb < 1024 * 1024) return `${fr1.format(mb / 1024)} Go`
  return `${fr1.format(mb / (1024 * 1024))} To`
}

/** Taille de fichier (entrée en octets) : 4,9 Ko · 16,7 Mo · 1,2 Go. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 ** 2) return `${fr1.format(bytes / 1024)} Ko`
  if (bytes < 1024 ** 3) return `${fr1.format(bytes / 1024 ** 2)} Mo`
  return `${fr1.format(bytes / 1024 ** 3)} Go`
}

/** 14 j 06 h · 5 h 03 · 12 min. */
export function formatUptime(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return '—'
  const minutes = Math.floor(totalSeconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} j ${String(hours % 24).padStart(2, '0')} h`
  if (hours > 0) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
  return `${minutes} min`
}
