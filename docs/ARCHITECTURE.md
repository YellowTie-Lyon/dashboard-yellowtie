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
```

`agent_heartbeat` a **un seul paramètre jsonb sans nom** : c'est la condition pour que PostgREST lui transmette le
corps JSON entier (un paramètre nommé fait échouer l'appel en `PGRST202`). Un test pgTAP verrouille cette exigence.
La logique vit dans `agent_heartbeat_impl`, fermée aux clients.

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

**Découverte des sites (agent 0.2.0)** : chaque agent peut joindre `"domains": ["exemple.fr", …]` (≤ 200), la liste des
dossiers de `~/sites` dont le nom ressemble à un nom de domaine (lecture par glob Bash, aucun processus). Envoyée à
l'installation, dès que le nombre de dossiers change, puis au moins toutes les 6 h, jamais avec un gros spool. Le
serveur normalise (minuscules), valide (mêmes règles que l'import manuel), crée les sites `source = 'discovered'`,
**vérifiés** (dossiers du client lui-même), ou rafraîchit `last_seen_at` ; il ne supprime jamais rien (un site absent
de `~/sites` depuis plus de 48 h est signalé dans l'interface). Plafond de 500 sites par hébergement. Les domaines
qui seront vus dans les access.log (phase 7) auront `source = 'log'` et resteront **non vérifiés** (un scanner peut
envoyer des `Host:` arbitraires).

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

### Trafic : analyse continue de l'access.log (agent 0.3.x, phase 7)

Décision révisée : au lieu d'une analyse déclenchée à l'ouverture d'un incident (action reçue de l'API), **chaque agent
analyse son propre `access.log` chaque minute**, au rythme du load. Le tableau de bord peut ainsi toujours afficher les domaines les
plus sollicités, et le trafic de la période d'un incident est déjà là quand l'incident s'ouvre. Aucune commande n'est
jamais reçue de l'API : la réponse du heartbeat reste inchangée.

Fonctionnement (bornes de charge) :
- **Octets nouveaux seulement** : le décalage (`tr_off`) et l'inode (`tr_ino`) du fichier sont mémorisés ; `tail -c +N`
  saute directement au bon endroit. Première analyse : on part de la fin du fichier (aucun historique relu).
- **Plafond de lecture** : 4 Mo par analyse (les plus récents ; le reste est marqué `trunc`), ramené à 1 Mo si le load 1 min
  dépasse 2 × le nombre de cœurs. Une rotation du log (inode différent) relit le nouveau fichier depuis le début.
- **3 processus courts par minute** (sous-shell, `tail`, `awk`), la priorité (`nice 19`) héritée du cron.
  Mesure : 30 000 lignes (4 Mo) en 0,14 s de CPU ; à chaque minute, quelques Ko seulement sont lus en temps normal.
- **Un seul `awk` (POSIX)** agrège et n'émet qu'un JSON borné (< 12 Ko) : jusqu'à 30 domaines (requêtes, octets,
  2xx/3xx/4xx/5xx, POST, robots), 15 URL (nom de domaine + chemin, requête réduite au nom du 1ᵉʳ paramètre, sans valeur),
  10 IP, types de visiteurs (navigateurs, Googlebot, autres robots, sans identifiant). Mémoire bornée (300 domaines,
  20 000 URL et IP distincts). Les lignes de log ne quittent jamais l'hébergement.
- **Envoi avec le heartbeat** (clé `traffic`, 3 fenêtres en attente au plus si le réseau échoue, fichier `~/.ik-monitor/traffic`).
  Le serveur retire `traffic` avant la logique existante (limite de 16 Ko conservée), limite globale de 64 Ko, n'ingère
  qu'après authentification et rate limit réussis, ignore une fenêtre invalide sans bloquer les autres, et n'accepte
  jamais deux fois la même fenêtre (`traffic_last_ts`).

Données (conservation courte pour ménager les quotas Supabase) :

| Table | Contenu | Rétention |
|---|---|---|
| `traffic_5m` | par hébergement, seau de 5 min et domaine (les fenêtres d'une minute s'additionnent dans leur seau) : requêtes, octets, 2xx–5xx, POST, robots | 3 jours |
| `traffic_detail` | par fenêtre : totaux, URL, IP, visiteurs (JSON) | 3 jours |
| `traffic_1h` | agrégat horaire par domaine | 30 jours |
| `incidents.traffic_snapshot` | trafic pendant l'incident, figé 6 min après la clôture | avec l'incident |

Lectures (RPC, RLS) : `get_top_domains` (top par Cloud), `get_hosting_traffic` (page d'un hébergement),
`get_incident_traffic` (hébergements et domaines « potentiellement impliqués »). Entretien `pg_cron` : `traffic_maintenance`
toutes les 10 min (agrégat horaire, instantanés d'incident), `purge_traffic` chaque nuit à 03:23 UTC. Les IP, données
personnelles, ne sont donc conservées que 3 jours ; les domaines vus dans les logs ne créent pas de sites (un scanner peut
envoyer des `Host:` arbitraires).

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

**Implémentation (phase 5)** : pg_cron évalue chaque Cloud **chaque minute** (`evaluate_all`) et écrit le résultat dans
`cloud_status` (statut, début, raisons, connectivité, diagnostic) ; `refresh_statuses()` recalcule immédiatement après un
changement de seuil. Les sondes utilisent `pg_net` (`run_probes`, toutes les minutes ; chaque hébergement n'est sondé que
quand c'est dû) ; toute la dépendance à pg_net est isolée dans deux fonctions (`probe_http_get`, `probe_http_result`), et une
erreur (extension absente) est visible dans l'interface au lieu d'être silencieuse. Les URL vers une adresse IP, un nom
local ou sans point ne sont jamais sondées.

Algorithme d'évaluation d'une règle (toutes les valeurs sont des données de `alert_rules`) :
1. **Niveau candidat** : sur la fenêtre `window_minutes`, `critical` si au moins `min_breach_ratio` des relevés dépassent le
   seuil Critical, sinon `warning` s'ils dépassent le seuil Warning, sinon `ok`. Moins de 60 % de relevés attendus dans la
   fenêtre : aucun changement (un manque de données n'est ni une alerte ni un retour à la normale).
2. **Montée immédiate**, **descente à l'hystérésis** : le niveau ne baisse que si, sur `recover_minutes`, **toutes** les
   valeurs restent sous (seuil − `recover_margin`). Critical → Warning puis Warning → Ok suivent chacun leur propre seuil.
3. **Statut du Cloud** : le pire niveau des règles actives. La surcharge d'un Cloud remplace la valeur par défaut, métrique
   par métrique ; une surcharge désactivée neutralise la règle pour ce Cloud.
4. **Connectivité (prioritaire)** : maintenance → `maintenance` ; aucun agent actif depuis `offline_after_seconds` →
   `offline` + diagnostic par les sondes ; agents vivants mais collecteur muet → `unknown` (valeurs obsolètes, aucune
   règle évaluée) ; agent en retard de plus de 90 s mais sous le seuil → statut normal, signalé « en retard ».

**Calibrage** : les valeurs par défaut sont des **valeurs de départ provisoires** semées pour chaque workspace (4 règles
actives : load 1 min par cœur 0,6 / 1,0 ; CPU 75 / 90 % ; RAM 85 / 95 % ; disque 80 / 90 % — 4 autres inactives : load 5 min
par cœur, load absolus, swap). Elles se modifient dans **Réglages** (défauts du workspace) et sur la page d'un Cloud
(surcharge), avec la distribution réelle des mesures sur 7 jours (médiane, p95, p99, max) sous chaque règle pour choisir des
seuils réalistes. Aucune notification externe n'est envoyée.

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

**Séries** *(implémenté, phase 4)* : `metrics` (par Cloud, 1/min), `metrics_1h` (moyenne **et maximum** par heure),
`job_state` (dernière exécution de l'agrégation et de la purge) ; à venir : `hosting_traffic_metrics`, `probe_results`.

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
- Données personnelles : les IP ne sont stockées qu'en agrégats top-N ; rétention 3 jours.

## 9. Volumes, quotas, rétention

Appels d'ingestion par mois (30 jours) : 2 collecteurs × 43 200 + 4 agents × 43 200 = **259 200**
(RPC PostgREST, non comptés comme invocations Edge). Edge : sondes ≈ 8 640 + `notify` ≈ 100, soit
≈ 2 % du quota Free de 500 000 invocations. Quotas à re-vérifier à la création du projet.

| Table | Rétention | Sert à |
|---|---|---|
| `metrics` (1 min) | 35 jours | graphiques 1 h, 6 h, 24 h, 7 j (et 30 j pour l'heure en cours) |
| `metrics_1h` (avg + max) | 400 jours | graphique 30 j et historique long |
| `probe_results` | 14 jours | |
| `traffic_5m`, `traffic_detail` | 3 jours | domaines, URL, IP, visiteurs (phase 7) |
| `traffic_1h` | 30 jours | trafic par domaine, historique |

Le frontend n'interroge jamais les tables pour les graphiques : la RPC `get_series(cloud_id, range)` (SECURITY
INVOKER, donc soumise à la RLS) choisit la source et la finesse et renvoie au plus 720 points :

| Période | Source | Points |
|---|---|---|
| 1 h, 6 h | relevés d'1 minute | 60 / 360 |
| 24 h | relevés regroupés par 5 min (à la volée) | 288 |
| 7 j | relevés regroupés par 15 min (à la volée) | 672 |
| 30 j | agrégats horaires + heure en cours calculée à la volée (sans agrégat : tout depuis les relevés) | 720 |

Chaque tranche porte **moyenne et pic**. Choix par rapport au plan initial : pas de table à 5 minutes. Conserver les
relevés d'une minute 35 jours coûte quelques Mo par Cloud (≈ 50 000 lignes) et évite une table de plus ; l'agrégat
horaire ne sert qu'au-delà. Un incident de plus de 35 jours n'est donc consultable qu'à l'heure près.

Maintenance (`pg_cron`, tâches créées par la migration si l'extension est disponible) : `rollup_metrics` toutes les
5 minutes (recalcule les 3 dernières heures, idempotent), `purge_old_data` chaque nuit à 03:17 UTC (garde-fou : jamais
sous 8 jours pour les relevés, 35 jours pour les agrégats). Sans `pg_cron`, `get_series` continue de fonctionner depuis
les relevés bruts et l'interface signale que l'agrégation ne tourne pas.

## 10. Dashboard

Cartes de **Server Clouds** (statut, CPU, load 1 m, RAM, disque, nombre d'hébergements et de sites, dernière
donnée) → détail Cloud (métriques, graphiques 1 h / 6 h / 24 h / 7 j / 30 j avec bandes d'incident, incidents,
hébergements, agents, diagnostics) → détail hébergement (Cloud parent, agent, domaines, diagnostics) →
détail domaine. Une page « valeurs brutes » permet de comparer avec la console Infomaniak.

**Actualisation automatique synchronisée** (aucun F5) : un minuteur central (`<LiveSync />`, 30 s) recharge toutes les
données de l'écran d'un seul coup (mesures, statuts, courbes, hébergements, domaines, incidents), pour que tout provienne du même
instant ; les données figées (incident clos) s'en excluent (`meta: { static: true }`). Elles se mettent en pause quand l'onglet est masqué et reprennent immédiatement au retour sur l'onglet et à la reconnexion
réseau. Un indicateur « En direct · actualisé il y a X s » est affiché dans l'en-tête ; « Connexion perdue · nouvelle
tentative automatique » apparaît si une requête de l'écran échoue. Réglages centralisés dans `apps/web/src/lib/live.ts`.

**Graphiques** (règles de lecture) : une courbe par unité (jamais deux échelles sur un axe), moyenne en trait plein et pic
de la tranche en zone claire, les interruptions de collecte **coupent** le trait, une seule infobulle pour toutes les
séries, un seul filtre de période au-dessus des quatre courbes, un tableau de valeurs équivalent. Couleurs des séries
validées en clair et en sombre (contrôle de contraste, de distinction daltonisme et de luminosité).

Vocabulaire centralisé dans `apps/web/src/lib/labels.ts` : « Top trafic pendant l'incident »,
« Hébergement / Domaine potentiellement impliqué ». « Activité anormale » n'apparaît que si une base de
référence existe.

## 11. Discord (abandonné à la demande du 30/09/2026)

Les notifications Discord ne sont plus prévues. Le mécanisme d'*outbox* ci-dessous reste la conception de référence si un canal
externe (Discord, e-mail, push) est un jour rajouté ; rien dans le code actuel n'en dépend.

Quatre messages au maximum par incident : `opened` (« Diagnostic en cours… »), `escalated`
(Warning → Critical), `diagnostic` (« 3/3 hébergements analysés » ou « 2/3, 1 agent n'a pas répondu »),
`recovered`. Pas de message par hébergement. Formatage en Europe/Paris.

**Incidents (phase 6)** : `evaluate_cloud` appelle `sync_incident` à chaque évaluation. Quatre types : `performance`
(load, CPU, RAM et swap regroupés en un seul incident), `disque`, `offline` (Cloud) et `agent` (un par hébergement : agent
silencieux alors que le Cloud répond, ou collecteur muet). Un seul incident ouvert par (Cloud, type, hébergement) : index
unique partiel. Cycle : `warning` ⇄ `critical` (montée/descente tracées) → `recovery` dès que le niveau repasse à normal →
`closed` après `incident_close_minutes` (Réglages, 5 min par défaut) de stabilité ; une rechute pendant `recovery` rouvre le
**même** incident. La fin d'un incident est le **début** du retour stable, pas l'instant de clôture. Chaque changement est un
événement de `incident_events` (chronologie) ; les pics par métrique et un instantané des valeurs au début sont conservés. La
maintenance gèle les incidents. Le client ne peut modifier que la `note` (colonne, propriétaire). `get_series_window` fournit les
courbes d'une période arbitraire (≤ 700 points ; agrégats horaires au-delà de 34 jours). Les incidents décrivent l'état observé,
sans affirmer de cause ; le diagnostic de trafic arrive en phase 7.

## 12. Plan de développement

| Phase | Contenu | État |
|---|---|---|
| 0 | Tests terrain | Fait (CPU synchronisé et comparaison console validés) |
| 1 | Fondations : repo, Vite/React/TS/Tailwind, Supabase (workspaces, RLS, tests), Auth sur invitation, CI, Netlify | Fait |
| 2 | Inventaire et tokens : Clouds, hébergements, sites, désignation du collecteur, génération / rotation / révocation de token | Fait |
| 3 | Agent + ingestion : `ik-agent.sh`, `install.sh`, `agent_heartbeat`, spool, tests, affichage du dernier relevé et de l'état des agents, découverte des sites, mode observation | Fait |
| 4 | Graphiques et données : `get_series`, agrégation horaire, purge, graphiques 1 h → 30 j, actualisation automatique | Fait |
| 5 | Seuils, statuts, silences, sondes (sans notification) : règles configurables, hystérésis, évaluation chaque minute, diagnostic des silences, sondes HTTP | Fait |
| 6 | Incidents et historique (notifications externes abandonnées à la demande) : cycle de vie, chronologie, pics, note, courbes de la période, bandes d'incident sur les graphiques | Fait |
| 7 | Diagnostic de trafic : agent 0.3.x (analyse d'access.log bornée), top domaines, page trafic d'un hébergement, trafic des incidents ; refonte de l'interface (charte noir et jaune) | Fait |
| 8 | Exploitation : santé du système (tâches planifiées, quota de stockage), interface responsive (mobile, tablette) et mode TV, mode d'emploi `RUNBOOK.md` | Fait |

**Exploitation (phase 8)** : `get_storage_stats()` (SECURITY DEFINER, membres seulement) renvoie la taille de la base et des 10
plus grosses tables ; Réglages affiche le quota (500 Mo en offre Free), l'état des six tâches planifiées (`evaluate`, `rollup`,
`traffic`, `probes`, `purge`, `traffic_purge`, avec leur retard toléré) et l'en-tête montre une pastille « Système » seulement en
cas de problème (tâche essentielle en retard ou jamais exécutée, stockage ≥ 70 %). Interface : conteneur `@container` sur les
panneaux Cloud (mesures 2 × 2 ou 4 × 1 selon la largeur réelle), navigation sur deux lignes en dessous de 1024 px, zones de toucher
de 2,5 rem sur écran tactile ; **mode TV** (`/tv`) : sans bouton, taille de base proportionnelle à la largeur (14 px → 36 px), écran
maintenu allumé (Wake Lock), curseur masqué après 5 s. Le mode d'emploi est dans `docs/RUNBOOK.md`.

## 13. Évolutions prévues (non développées au MVP)

Monitoring de sites individuels, temps de réponse HTTP, certificats SSL, statistiques Cloudflare, détection de
bots, comparaison trafic / charge, statistiques WordPress, MySQL, notifications e-mail / push, plusieurs
utilisateurs et groupes de serveurs, lecture incrémentale des logs (inode + offset) pour un req/min permanent.
Le modèle y est préparé (`extra jsonb`, `metric_definitions`, `workspace_id`, `hosting_traffic_metrics`).
