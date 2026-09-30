# YellowScope

Supervision de Serveurs Cloud managés Infomaniak (sites WordPress/WooCommerce) : santé en quasi temps réel,
incidents, alertes Discord et diagnostic de trafic.

- **Architecture** : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Mise en route** (Supabase, Netlify, GitHub Actions) : [`docs/setup.md`](docs/setup.md)

## Structure

```
apps/web/     Dashboard (Vite + React + TypeScript + Tailwind) → Netlify
agent/        Agent Bash installé sur les hébergements (phase 3)
supabase/     Migrations SQL, tests pgTAP, configuration locale
docs/         Architecture et procédures
```

## Développement

```sh
pnpm install
pnpm dev                 # dashboard en local
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Aucun secret dans ce dépôt : voir `.env.example` et `docs/setup.md`.
