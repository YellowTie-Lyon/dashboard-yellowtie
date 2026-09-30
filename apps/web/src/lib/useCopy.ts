import { useCallback, useEffect, useRef, useState } from 'react'

/** Copie dans le presse-papiers et signale « copié » 2 s ; `failed` si le navigateur refuse. */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setFailed(false)
      setCopied(key)
    } catch {
      setFailed(true)
      setCopied(null)
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 2000)
  }, [])
  return { copied, failed, copy }
}
