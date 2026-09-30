// Publie l'agent avec le site : copie agent/ik-agent.sh et agent/install.sh dans public/agent/ et génère
// SHA256SUMS (vérifié par install.sh avant toute installation). Exécuté avant `dev` et `build`.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const out = join(root, 'apps', 'web', 'public', 'agent')
const files = ['ik-agent.sh', 'install.sh']

mkdirSync(out, { recursive: true })
const sums = files.map((name) => {
  copyFileSync(join(root, 'agent', name), join(out, name))
  const hash = createHash('sha256').update(readFileSync(join(out, name))).digest('hex')
  return `${hash}  ${name}`
})
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
console.log(`agent publié dans public/agent (${files.join(', ')})`)
