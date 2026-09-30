# Agent YellowScope

Script Bash (`ik-agent.sh`) lancé par cron chaque minute sur chaque hébergement Infomaniak. Sans root, sans démon,
sans dépendance autre que `curl`.

- **Collecteur système** (1 par Server Cloud, désigné dans l'application) : envoie load, CPU %, RAM, swap, disque,
  uptime, cœurs.
- **Autres hébergements** : heartbeat léger (~300 octets).
- N'exécute **jamais** de commande reçue de l'API (liste blanche d'actions, phase 7).

Installation, vérifications et désinstallation : [`docs/setup.md`](../docs/setup.md#phase-3--installer-lagent-sur-un-hébergement).
Protocole et contraintes de conception : [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#5-agents).

## Fichiers

| Fichier | Rôle |
|---|---|
| `ik-agent.sh` | l'agent |
| `install.sh` | installeur idempotent (téléchargement vérifié par SHA-256, config, cron) |
| `tests/run.sh`, `tests/install-test.sh` | tests (curl, df et crontab simulés, aucun accès réseau) |

`ik-agent.sh` et `install.sh` sont publiés avec le site (`/agent/`) au moment du build, avec un `SHA256SUMS`.

## Tests

```sh
shellcheck -x ik-agent.sh install.sh tests/*.sh tests/bin/*
tests/run.sh
tests/install-test.sh
```

Variables d'environnement réservées aux tests : `IK_HOME`, `IK_STATE_DIR`, `IK_PROC_DIR`, `IK_NOW`,
`IK_INSTALL_ALLOW_FILE`.
