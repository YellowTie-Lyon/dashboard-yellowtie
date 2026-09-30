# Architecture – YellowScope

Supervision de Serveurs Cloud managés Infomaniak hébergeant des sites WordPress/WooCommerce.
Ce document est la source de vérité de l'architecture validée avant le début du développement.
Il est mis à jour à chaque décision structurante.

## 1. Principes

- **Push uniquement** : ce sont les serveurs qui envoient leurs métriques. Aucune connexion SSH entrante.
- **Aucun privilège root** : l'agent est un script Bash lancé par cron, sans démon.
- **Le monitoring ne doit jamais aggraver une surcharge** : collecte légère en temps normal, analyse
  lourde uniquement à la demande, toujours bornée (octets, temps, mémoire).
- **Identité dérivée du token, jamais du JSON** : un agent ne peut pas publier au nom d'un autre.
- **Corrélation ≠ causalité** : l'interface ne dit jamais qu'un domaine « cause » une surcharge.
- **Rien n'est codé en dur** : seuils, fenêtres, hystérésis, délais et rétentions sont des données.
- **Aucun secret dans Git.**

## 2. Infrastructure réelle

Trois niveaux, à ne jamais confondre :

```
workspace
  └─ cloud_servers      métriques système (load, CPU, RAM, swap, disque, uptime)
       └─ web_hostings  agent, access.log, sondes, tokens
            └─ sites    domaines (découverts dans les logs ou saisis)
```

Aujourd'hui : 2 Server Clouds, 6 hébergements (3 par Cloud), ≈ 110 sites. Chaque hébergement a son
propre accès SSH, son utilisateur, son cron et son `~/ik-logs/access.log`. Rien n'est spécifique à
« 2 serveurs / 6 hébergements » dans le code.

### Constats terrain (30/09/2026)

| Constat | Conséquence |
|---|---|
| `/proc/loadavg`, `/proc/meminfo`, `/proc/stat` reflètent le **Cloud parent**, pas l'hébergement. Deux hébergements du même Cloud partagent hostname, noyau (compteur de PID quasi identique) et volume disque (`/dev/mapper/vgdata-client`, même fsid) | Les métriques système appartiennent au Cloud. **Un seul agent par Cloud les collecte** (`system_metrics_collector`). Disque et load sont des métriques de Cloud |
| 12 vCPU par Cloud | Load évalué **par cœur** (`load1_per_core`). Un load de 5,8 ≈ 0,49/cœur : les seuils se calibrent sur l'historique réel |
| `ulimit -u` = 480 processus par utilisateur | L'agent minimise les forks (Bash builtins, 1 `curl`/min, `df` toutes les 5 min) et tolère un échec de fork |
| curl 7.74.0, bash 5.1, flock, timeout, ionice, nice, mawk présents | Pas de `--fail-with-body`/`--json` ; `--header @fichier` disponible ; verrou par `flock -n` |
| Log : `vhost ip - - [date] "requête" statut octets "referer" "UA"`, fuseau +0200, rotation quotidienne à 00:00 (`access.log-AAAAMMJJ.gz`, ~30 j), lecture seule | Le domaine est le 1ᵉʳ champ. Les `.gz` sont exclus du MVP (`truncated` + `covered_from` si la fenêtre chevauche minuit) |
| 16,7 Mo / 55 166 lignes lus en 0,185 s (≈ 300 octets/ligne, ≈ 100 req/min en moyenne) | Défauts d'analyse : `window_minutes` = 10, `max_bytes` = 32 Mo |

À vérifier avant la phase 3 : test CPU synchronisé entre deux hébergements du même Cloud, et
comparaison vCPU / RAM / disque avec la console Infomaniak.

## 3. Vue d'ensemble

```
 SERVER CLOUD                                        SUPABASE
 ┌───────────────────────────────┐   HTTPS   ┌───────────────────────────────────────────┐
 │ Hébergement A ─ agent COLLECTOR ├────────►│ RPC PostgREST (SECURITY DEFINER)           │
 │   /proc + df → système 1×/min  │  1×/min   │   agent_heartbeat(payload) ← token header  │
 │ Hébergement B ─ agent          ├────────►│   agent_submit_diagnostic(...)  (phase 7)  │
 │   heartbeat léger 1×/min       │           │        │ 1 transaction SQL                 │
 │ Hébergement C ─ agent          ├────────►│        ▼                                   │
 │   heartbeat léger 1×/min       │◄────────┤ PostgreSQL : métriques, règles, incidents, │
 └───────────────────────────────┘ {actions} │   diagnostics, outbox                      │
   analyze_logs borné, sur demande            │ pg_cron : silences, rollups, purge, sondes │
                                              │ Edge `notify` (Discord) · Edge `probe`     │
                                              │ Auth + RLS + Realtime                      │
                                              └──────────────────────▲────────────────────┘
                                                                     │ supabase-js (clé publique + session)
                                                        Netlify : SPA React / TypeScript / Vite
```

## 4. Décisions

| Sujet | Choix | Raison |
|---|---|---|
| Frontend | React + TypeScript + Vite, Tailwind, TanStack Query, React Router, Recharts | SPA statique, aucun SSR nécessaire ; tout le backend est dans Supabase |
| Hébergement front | Netlify (statique), déploiement continu depuis GitHub | |
| Base et backend | Supabase (PostgreSQL, PostgREST, Auth, RLS, Realtime, pg_cron, Edge Functions) | Toutes les briques dont le projet a besoin, sans serveur à maintenir |
| **Ingestion** | **Hybride** : RPC PostgREST (fonctions `agent_*` du schéma `public`, `EXECUTE` ouvert à `anon` mais token obligatoire) pour heartbeats et diagnostics ; Edge Functions seulement pour `notify` (Discord) et `probe` | Le chemin à haute fréquence (259 200 appels/mois) ne consomme aucune invocation Edge. Logique critique en SQL, atomique et testable |
| Logique métier | PL/pgSQL (une transaction par heartbeat) + tests pgTAP | Atomicité, pas de double alerte |
| Notifications | Pattern *outbox* + `dedupe_key` unique | L'anti-spam est garanti par une contrainte, pas par la bonne volonté |
| Agent | Bash (builtins) + curl ; awk uniquement pour l'analyse de logs | Aucune dépendance, peu de forks |
| Mises à jour d'agent | Manuelles (`install.sh` idempotent + checksum), jamais automatiques | Une mise à jour serveur-pilotée serait de l'exécution de code à distance |
| Environnement de dev | Migrations versionnées, appliquées par GitHub Actions | Voir `docs/setup.md` |

## 5. Agents

Un seul script (`ik-agent.sh`) est installé sur chaque hébergement. Son rôle est décidé **côté serveur**
(`web_hostings.system_metrics_collector`) et renvoyé dans la réponse du heartbeat : changer de
collecteur ne demande aucune réinstallation.

| | Collecteur système (1 par Cloud) | Agent d'hébergement |
|---|---|---|
| Fréquence | 1×/min | 1×/min |
| Envoie | heartbeat + `points` (load 1/5/15, CPU %, RAM, swap, disque + périphérique, uptime, cœurs) | heartbeat seul (~300 octets) |
| Aussi | version, erreurs locales, taille et inode de `access.log` | idem |
| Spool local | oui (30 points, renvoyés en lot après une coupure) | non |
| Analyse de logs | uniquement sur action reçue | idem |

Règles côté serveur :
- Des `points` envoyés par un agent non collecteur sont **ignorés** (anomalie `points_ignored`).
- Index unique partiel : exactement un collecteur par Cloud.
- Le `hostname` d'un hébergement doit correspondre à celui de son Cloud (appris au premier relevé du collecteur),
  sinon anomalie `hostname_mismatch` (détecte une erreur de rattachement).

Calcul du CPU % : `100 × (1 − Δ(idle+iowait) / Δtotal)` entre deux relevés de `/proc/stat` conservés dans
le fichier d'état de l'agent. Premier relevé, redémarrage ou compteur décroissant : `cpu_pct = null`.

### Protocole (implémenté, phase 3)

```
POST {SUPABASE_URL}/rest/v1/rpc/agent_heartbeat
apikey: <clé publique>                (exigée par la passerelle, non secrète)
x-agent-token: ikh_<12 hex>_<64 hex>  (via curl -H @fichier 600, jamais dans ps)
Prefer: params=single-object          (le corps JSON est le paramètre)
```

```json
{ "v": 1, "agent_version": "0.1.0", "hostname": "od-34b55c",
  "agent": { "backlog": 0, "last_error": null, "log": { "size": 16733972, "inode": 12345 } },
  "points": [ { "ts": 1767000000, "cpu_cores": 12, "load": [2.43, 3.13, 4.12], "cpu_pct": 15.1,
                "mem": { "total_mb": 36093, "used_mb": 11937, "avail_mb": 24156 },
                "swap": { "total_mb": 4095, "used_mb": 0 },
                "disk": { "device": "/dev/mapper/vgdata-client", "total_mb": 281589, "used_mb": 141757, "avail_mb": 139843 },
                "uptime_s": 1234567 } ] }
```

Le serveur dérive hébergement et Cloud **uniquement du token** (SHA-256 du secret comparé au hash stocké ;
ancien hash accepté pendant la période de grâce d'une rotation). Contrôles, dans l'ordre :

| Contrôle | Résultat |
|---|---|
| Token absent, mal formé, inconnu, révoqué ou faux | 401 (message identique dans tous les cas) |
| Hébergement désactivé | 403 |
| Moins de 20 s depuis le dernier heartbeat | 429 |
| Corps non objet, > 16 Ko, `v` ≠ 1, `points` non tableau ou > 30 | 400 |
| Point invalide (bornes, `used ≤ total`, horodatage hors [now − 24 h ; now + 2 min]…) | point **ignoré** et compté dans `rejected`, sans bloquer les autres |

Les relevés sont idempotents (clé primaire (Cloud, `ts`)) : rejouer un spool ne crée pas de doublon. Le serveur
calcule les dérivés (`load1_per_core`, `*_used_pct`), met à jour l'état du Cloud et de l'hébergement, apprend le
`hostname` et le nombre de cœurs du Cloud, puis répond :

```json
{"ok": true, "server_time": 1767000000, "collector": true, "accepted": 1, "rejected": 0, "actions": []}
```

### Agent : fonctionnement local (`agent/ik-agent.sh`)

- Lancé par cron chaque minute (`nice -n 19`). Verrou sans fork (PID + vérification du nom du processus).
- 1 fork obligatoire par minute (`curl`) ; `df`, `stat` et le comptage des cœurs seulement toutes les 5 minutes.
- État dans `~/.ik-monitor/` (dossier 700, fichiers 600) : `config`, `state`, `spool` (30 relevés max),
  `agent.log` (plafonné à 50 Ko, écrit uniquement lors d'un changement d'état).
- Le rôle de collecteur vient de la réponse du serveur ; sans rôle, l'agent n'envoie qu'un heartbeat.
- Échec réseau / 5xx / 401 : le spool conserve les relevés, renvoyés en lot ensuite dans l'ordre chronologique.
- Installation : `install.sh` (téléchargement + vérification SHA-256, configuration, cron idempotent, sauvegarde de
  la crontab). Le token est demandé en saisie masquée.

### Actions (`heartbeat` → `analyze_logs` → résultat)

1. Un incident s'ouvre : une ligne `incident_diagnostics` `pending` est créée pour chaque hébergement du
   Cloud (paramètres serveur : `window_minutes`, `max_bytes`, `expires_at`).
2. Au heartbeat suivant (≤ 60 s), la réponse contient l'action. La ligne passe en `delivered` ; sans résultat
   après 2 min, elle est re-livrée (2 tentatives max).
3. L'agent n'exécute **qu'une liste blanche d'actions codées localement** (`analyze_logs`), avec des paramètres
   numériques qu'il borne lui-même (fenêtre ≤ 30 min, ≤ 64 Mo). Jamais de commande arbitraire.
4. Analyse détachée : `nice -n 19`, `ionice -c3`, `flock`, `timeout` 90 s, `LC_ALL=C`, `tail -c max_bytes`
   (1ʳᵉ ligne partielle ignorée) puis un seul `mawk`/`awk`, mémoire bornée (au-delà de 50 000 clés
   distinctes, le reste va dans « autres » avec `cardinality_capped`). `truncated` + `covered_from` si la
   fenêtre n'est pas entièrement couverte.
5. Résultat renvoyé par `agent_api.submit_diagnostic(action_id, result)` (≤ 64 Ko) ; en cas d'échec il reste
   en spool jusqu'à `expires_at`.
6. Quand tous les hébergements ont répondu, ou à l'échéance (300 s par défaut), le diagnostic est **finalisé** :
   agrégation inter-hébergements, une seule ligne d'outbox. Un résultat tardif est conservé mais ne
   déclenche pas de nouveau message.

Un diagnostic peut aussi être demandé à la main (bouton « Analyser le trafic maintenant »,
`trigger = 'manual'`, même garde-fou d'intervalle minimum).

## 6. Statuts, incidents, silences

**Statuts d'un Cloud** : Normal · Warning · Critical · Offline (+ « données système obsolètes » si le
collecteur est muet). Un état intermédiaire « retard » s'affiche entre 90 s et le seuil offline, sans
notification.

**Types d'incident** : `performance` (load, CPU, RAM, swap), `disk`, `offline`, `agent`.
Load + CPU + RAM ne créent jamais trois incidents : une seule alerte `performance`.

**Cycle de vie** : `NORMAL → WARNING → CRITICAL → RECOVERY → CLOSED`, historisé dans `incident_events`.

- Ouverture : au moins `min_breach_ratio` des points de la fenêtre `window_minutes` dépassent le seuil.
  Les points manquants ne comptent ni comme dépassement ni comme retour à la normale.
- Warning → Critical : notification. Critical → Warning : silencieux.
- Recovery : plus aucun dépassement, minuteur `recover_minutes` en cours. Un nouveau dépassement revient
  à Warning/Critical dans le **même** incident (événement `relapse`, pas de nouvelle notification).
- Closed : retour stable pendant `recover_minutes` (seuil − `recover_margin`). Notification de rétablissement.
- Index unique partiel : un seul incident non clos par (Cloud, type).

**Silences** :

| Observation | Conclusion |
|---|---|
| Agent d'un hébergement muet, autres agents du Cloud vivants | Incident `agent` sur cet hébergement |
| Collecteur muet, autres agents vivants | Incident `agent` (collecteur) ; valeurs système grisées, jamais « normal » |
| Tous les agents du Cloud muets > `offline_after` (240 s par défaut) | Incident `offline`, qualifié par les sondes |

**Sondes `probe_url`** (une par hébergement, URL statique conseillée) :

| Heartbeat | Sonde | Formulation |
|---|---|---|
| absent | OK | « Problème probable agent / cron » |
| absent | KO (2 échecs consécutifs) | « Hébergement / Server Cloud potentiellement inaccessible » |
| absent | non configurée | « Cause indéterminée » |

Jamais « serveur mort ». Une réponse HTTP < 500 compte comme OK. Sonde de base toutes les 5 min, chaque
minute pendant une suspicion.

**Calibrage** : les notifications sont désactivées par défaut (`notifications_enabled = false`). Les statuts
et incidents se calculent quand même. Les seuils par défaut sont des valeurs de départ seedées en base
(RAM 85/95 %, disque 80/90 %, load/cœur et CPU provisoires) et se modifient dans l'interface.

## 7. Modèle de données

**Tenancy** : `workspaces`, `workspace_members` *(implémenté, phase 1)*.

**Inventaire** *(implémenté, phase 2)* : `cloud_servers`, `web_hostings`, `sites`, `audit_log`.
- Le token d'agent a la forme `ikh_<12 hex publics>_<64 hex secrets>`. `web_hostings` ne porte que la partie
  publique (`token_public_id`, `token_active`) ; les hash vivent dans `web_hosting_credentials`, table
  **sans aucun droit pour le client** (accessible seulement aux fonctions `SECURITY DEFINER`). Seul le SHA-256
  du secret est stocké, avec le hash précédent et son échéance pour la rotation « en douceur » (24 h par défaut).
- Le client n'écrit que des colonnes explicitement autorisées (GRANT par colonne). `workspace_id` est dérivé du
  Server Cloud parent par trigger, `system_metrics_collector` et les champs de token ne s'écrivent que par RPC.
- RPC (propriétaire requis) : `rotate_hosting_token`, `revoke_hosting_token`, `set_system_collector`
  (atomique ; le 1ᵉʳ hébergement d'un Cloud est désigné automatiquement), `import_sites` (normalisation,
  doublons ignorés, ≤ 500 domaines ; le domaine est conservé tel quel, `www.` inclus, pour correspondre au
  vhost des logs).
- `sites` : unique par (hébergement, domaine) ; les domaines découverts dans les logs (phase 7) seront
  marqués non vérifiés et plafonnés, car un scanner peut envoyer des `Host:` arbitraires.

**État chaud** : `cloud_server_state` (Realtime), `web_hosting_state` (polling).

**Séries** : `metrics` (par Cloud, 1/min), `metrics_5m`, `metrics_1h` (avg **et max**), `hosting_traffic_metrics`,
`probe_results`.

**Alertes** : `metric_definitions`, `alert_rules` (règle par défaut du workspace, surchargeable par Cloud :
`warn_threshold`, `crit_threshold`, `window_minutes`, `min_breach_ratio`, `recover_margin`,
`recover_minutes`), `alert_state`.

**Incidents** : `incidents`, `incident_events`, `incident_diagnostics` (file d'actions et résultat par
hébergement), `incident_diagnostic_sites` (top 20 domaines + « autres »).

**Notifications et divers** : `notification_channels`, `notification_outbox` (payload figé à la création,
`dedupe_key` unique), `settings`, `audit_log`.

RLS : lecture réservée aux membres du workspace ; `token_hash`, `prev_token_hash` et `webhook_url` exclus des
GRANT ; écritures des agents uniquement via `agent_api.*` ; aucune écriture directe depuis le client.

## 8. Sécurité

- Un token par hébergement, stockage du hash uniquement, rotation possible (période de grâce), jamais
  exposé au frontend.
- Webhook Discord jamais lisible côté client (écriture par RPC, lecture par `notify` avec `service_role`).
- `service_role` uniquement dans les secrets Supabase ; le frontend n'a que la clé publique + session.
- Inscription publique désactivée ; comptes créés par l'administrateur.
- Validation stricte des payloads, rate limit par hébergement, `statement_timeout` du rôle `anon`,
  rejet immédiat des tokens mal formés.
- Actions d'agent : liste blanche, paramètres bornés des deux côtés.
- En-têtes de sécurité et CSP via `netlify.toml`.
- Tests pgTAP de la RLS en CI ; scan de secrets en CI.
- Données personnelles : les IP ne sont stockées qu'en agrégats top-N ; rétention 30 jours.

## 9. Volumes, quotas, rétention

Appels d'ingestion par mois (30 jours) : 2 collecteurs × 43 200 + 4 agents × 43 200 = **259 200**
(RPC PostgREST, non comptés comme invocations Edge). Edge : sondes ≈ 8 640 + `notify` ≈ 100, soit
≈ 2 % du quota Free de 500 000 invocations. Quotas à re-vérifier à la création du projet.

| Table | Rétention | Sert à |
|---|---|---|
| `metrics` (1 min) | 7 jours | graphiques 1 h, 6 h |
| `metrics_5m` | 35 jours | 24 h, 7 j |
| `metrics_1h` | 400 jours | 30 j et historique |
| `probe_results` | 14 jours | |
| `incident_diagnostics*` | 30 jours | |

Le frontend n'interroge jamais les tables pour les graphiques : une RPC `get_series(cloud_id, range)` choisit
la bonne table et renvoie ≤ 2 000 points.

## 10. Dashboard

Cartes de **Server Clouds** (statut, CPU, load 1 m, RAM, disque, nombre d'hébergements et de sites, dernière
donnée) → détail Cloud (métriques, graphiques 1 h / 6 h / 24 h / 7 j / 30 j avec bandes d'incident, incidents,
hébergements, agents, diagnostics) → détail hébergement (Cloud parent, agent, domaines, diagnostics) →
détail domaine. Une page « valeurs brutes » permet de comparer avec la console Infomaniak.

Vocabulaire centralisé dans `apps/web/src/lib/labels.ts` : « Top trafic pendant l'incident »,
« Hébergement / Domaine potentiellement impliqué ». « Activité anormale » n'apparaît que si une base de
référence existe.

## 11. Discord

Quatre messages au maximum par incident : `opened` (« Diagnostic en cours… »), `escalated`
(Warning → Critical), `diagnostic` (« 3/3 hébergements analysés » ou « 2/3, 1 agent n'a pas répondu »),
`recovered`. Pas de message par hébergement. Formatage en Europe/Paris.

## 12. Plan de développement

| Phase | Contenu | État |
|---|---|---|
| 0 | Tests terrain | Fait (CPU synchronisé + comparaison console à finaliser) |
| 1 | Fondations : repo, Vite/React/TS/Tailwind, Supabase (workspaces, RLS, tests), Auth sur invitation, CI, Netlify | Fait |
| 2 | Inventaire et tokens : Clouds, hébergements, sites, désignation du collecteur, génération / rotation / révocation de token | Fait |
| **3** | **Agent + ingestion** : `ik-agent.sh`, `install.sh`, `agent_heartbeat`, spool, tests, affichage du dernier relevé et de l'état des agents, mode observation | **En cours de validation** |
| 4 | Dashboard : cartes, détails, `get_series`, rollups, rétention, valeurs brutes | À faire |
| 5 | Règles, statuts, silences, sondes | À faire |
| 6 | Incidents et Discord, historique | À faire |
| 7 | Diagnostic de trafic (`analyze_logs`), découverte de sites, UI de comparaison | À faire |
| 8 | Durcissement, runbook, production | À faire |

## 13. Évolutions prévues (non développées au MVP)

Monitoring de sites individuels, temps de réponse HTTP, certificats SSL, statistiques Cloudflare, détection de
bots, comparaison trafic / charge, statistiques WordPress, MySQL, notifications e-mail / push, plusieurs
utilisateurs et groupes de serveurs, lecture incrémentale des logs (inode + offset) pour un req/min permanent.
Le modèle y est préparé (`extra jsonb`, `metric_definitions`, `workspace_id`, `hosting_traffic_metrics`).
