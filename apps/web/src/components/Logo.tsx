/** Logo YellowScope : le même pictogramme que le favicon (carré jaune, pouls noir). */
export function Logo({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="7" fill="#facc15" />
      <path d="M5 18h5l3-8 5 14 3-9 2 3h4" fill="none" stroke="#111827" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
