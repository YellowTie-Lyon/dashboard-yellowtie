# Mise en route (phase 1)

À faire une seule fois, dans cet ordre. Aucun secret n'est saisi dans Git.

## 1. Projet Supabase

1. Créez un projet sur <https://supabase.com> (région UE conseillée).
2. **Authentication → Sign In / Providers → Email** : désactivez **Allow new users to sign up**
   (accès sur invitation uniquement).
3. **Authentication → URL Configuration** : *Site URL* = l'URL Netlify du site (à renseigner après l'étape 4).
4. Notez, dans **Project Settings → API** : l'URL du projet et la clé publique (`anon` / *publishable*).
   Ne copiez **jamais** la clé `service_role` dans Netlify ou GitHub.

## 2. Appliquer les migrations (avant de créer votre utilisateur)

La migration `20260930000001_workspaces.sql` installe un déclencheur : **le premier utilisateur créé devient
propriétaire du workspace**. Appliquez-la donc avant de créer votre compte.

Soit avec la CLI Supabase en local :

```sh
supabase login
supabase link --project-ref <ref>
supabase db push
```

Soit avec GitHub Actions (workflow *Déployer les migrations*), après avoir défini dans
**GitHub → Settings → Secrets and variables → Actions** :

| Nom | Type | Valeur |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | jeton personnel Supabase (Account → Access Tokens) |
| `SUPABASE_DB_PASSWORD` | secret | mot de passe de la base du projet |
| `SUPABASE_PROJECT_REF` | variable | identifiant du projet |

Le workflow utilise un *Environment* GitHub nommé `production` : vous pouvez y exiger une approbation manuelle.

## 3. Créer votre utilisateur

**Authentication → Users → Add user → Create new user** : e-mail + mot de passe, cochez **Auto Confirm User**.

Vérification (SQL Editor) :

```sql
select w.name, m.role, u.email
from public.workspace_members m
join public.workspaces w on w.id = m.workspace_id
join auth.users u on u.id = m.user_id;
```

Si l'utilisateur a été créé **avant** la migration (aucune ligne), rattachez-le à la main :

```sql
with ws as (insert into public.workspaces (name) values ('YellowTie') returning id)
insert into public.workspace_members (workspace_id, user_id, role)
select ws.id, u.id, 'owner' from ws, auth.users u where u.email = 'vous@example.com';
```

Les utilisateurs suivants ne sont pas rattachés automatiquement : insérez-les dans `workspace_members`
(la gestion multi-utilisateur n'a pas d'interface au MVP).

## 4. Netlify

1. **Add new site → Import from Git** : choisissez le dépôt. La configuration de build vient de `netlify.toml`.
2. **Site configuration → Environment variables** :

| Variable | Valeur |
|---|---|
| `VITE_SUPABASE_URL` | URL du projet Supabase |
| `VITE_SUPABASE_ANON_KEY` | clé publique (`anon` / *publishable*) |

3. Déployez, puis reportez l'URL du site dans *Site URL* côté Supabase (étape 1.3).

## 5. Vérifier

Ouvrez le site, connectez-vous : le tableau de bord affiche « Workspace : YellowTie ». C'est le test de bout
en bout de la phase 1 (authentification + RLS).

## Développement local

```sh
pnpm install
cp .env.example apps/web/.env.local   # puis renseignez les deux variables publiques
pnpm dev
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Tests SQL en local (Docker requis) : `supabase start && supabase test db`.

## Phase 2 : saisir l'inventaire

Une fois connecté (rôle propriétaire) :

1. **Server Clouds → Ajouter un Server Cloud** : nom, nombre de vCPU (12 pour vos Clouds actuels), seuil offline
   (240 s par défaut).
2. Ouvrez le Cloud, **Ajouter un hébergement** (par exemple `Web-Cloud-YellowTie-1`). Le premier hébergement d'un
   Cloud devient automatiquement son **collecteur système** ; vous pouvez en désigner un autre à tout moment.
3. Ouvrez l'hébergement : **Générer le token**. Il n'est affiché **qu'une seule fois** : copiez-le tout de suite
   dans votre gestionnaire de mots de passe. Il servira à installer l'agent (phase 3).
4. **Domaines** : l'agent (version 0.2.0 et suivantes) détecte tout seul les sites à partir du dossier `~/sites` de
   l'hébergement et les remonte (au plus toutes les 6 h). Le bouton **Importer des domaines** reste disponible pour
   compléter à la main : utilisez alors le nom tel qu'il apparaît dans le premier champ de `~/ik-logs/access.log`
   (avec `www.` si c'est le cas).
5. Optionnel : renseignez l'URL de sonde (HTTPS) de l'hébergement. Un petit fichier statique est conseillé.

Les migrations de `main` sont appliquées automatiquement par le workflow *Déployer les migrations* (une
approbation peut être exigée via l'environnement GitHub `production`). Vérifiez son succès dans l'onglet
**Actions** avant de tester l'interface.

## Phase 3 : installer l'agent sur un hébergement

À faire pour chaque hébergement (6 au total). Commencez par le **collecteur système** d'un Cloud.

1. Dans YellowScope, ouvrez l'hébergement et générez (ou régénérez) son token. La fenêtre affiche aussi la
   **commande d'installation** : copiez-la.
2. Connectez-vous en SSH à l'hébergement (console Infomaniak > Web & Domaines > votre hébergement > SSH).
3. Collez la commande d'installation (deux lignes). L'installeur vous demande le token : collez-le
   (rien ne s'affiche, c'est normal). Il télécharge l'agent, vérifie sa somme de contrôle, écrit la configuration
   (lecture seule pour vous), ajoute **une** ligne dans votre crontab (les autres tâches sont conservées) et
   fait un premier envoi de test.
4. Attendez 1 à 2 minutes : sur la page de l'hébergement, « État de l'agent » affiche le dernier heartbeat ;
   sur la page du Cloud, « Dernier relevé système » affiche load, CPU, RAM, swap et disque (le CPU affiche « — »
   au tout premier relevé, c'est normal : il se calcule entre deux relevés).

Vérifications sur le serveur : `crontab -l` (une ligne `ik-monitor`), `cat ~/.ik-monitor/agent.log` (vide tant
que tout va bien), `~/.ik-monitor/ik-agent.sh --dry-run` (affiche ce qui serait envoyé, sans rien envoyer).

Désinstaller : `bash ik-install.sh --uninstall` (retire la ligne de cron et le dossier `~/.ik-monitor`).

**Mode observation** : tant que la phase 5 n'est pas livrée, aucun statut ni alerte n'est calculé. Les valeurs
servent à les comparer avec la console Infomaniak avant de fixer les seuils.

### Mettre à jour un agent déjà installé

Sur la page de l'hébergement, bouton **« Mettre à jour l'agent »** (carte « Token d'agent ») : il affiche la commande à copier. Ou relancez simplement les deux lignes de la commande d'installation (« Régénérer » n'est
**pas** nécessaire) : l'installeur télécharge la dernière version, vérifie sa somme de contrôle et remplace
l'agent. À la question du token, appuyez sur **Entrée** pour conserver l'actuel.

## Phase 4 : graphiques et maintenance des données

- Les graphiques (1 h, 6 h, 24 h, 7 j, 30 j) sont sur la page de chaque Server Cloud, sous « Dernier relevé système ».
  Ils se mettent à jour tout seuls : plus besoin de recharger la page (voir l'indicateur « En direct » en haut).
- La migration de la phase 4 essaie d'activer l'extension **pg_cron** et planifie l'agrégation (toutes les 5 minutes)
  et la purge (chaque nuit). Si l'extension n'a pas pu être activée, le bas des graphiques affiche
  « L'agrégation horaire n'a pas tourné récemment » : activez-la dans **Supabase > Database > Extensions > pg_cron**,
  puis lancez dans **SQL Editor** :

  ```sql
  select cron.schedule('yellowscope-rollup', '*/5 * * * *', 'select public.rollup_metrics(interval ''3 hours'')');
  select cron.schedule('yellowscope-purge', '17 3 * * *', 'select public.purge_old_data()');
  ```
  (Sans cela, les graphiques fonctionnent quand même depuis les relevés d'une minute, mais rien n'est agrégé ni purgé.)
- Vérifier que les tâches existent : `select jobname, schedule, active from cron.job;`

## Phase 5 : seuils, statuts et sondes

- **Statuts** : chaque Server Cloud affiche Normal, Warning, Critical, Offline, Maintenance ou Aucune donnée, recalculé chaque
  minute. Ouvrez la page d'un Cloud : le cadre « Statut » liste les raisons (métrique, valeur, seuils, depuis quand) ou, en cas
  de silence, le diagnostic.
- **Seuils** : menu **Réglages** (valeurs par défaut de tous les Clouds) et « Seuils d'alerte de ce Server Cloud » sur la page
  d'un Cloud (personnalisation). Les valeurs de départ sont **provisoires** : sous chaque règle, comparez avec les mesures
  réelles des 7 derniers jours (médiane, p95, p99, max), puis ajustez. L'enregistrement recalcule les statuts aussitôt.
  Les six réglages d'une règle : seuil Warning, seuil Critical, fenêtre (minutes), part de relevés au-dessus du seuil,
  marge de retour et durée de retour stable (hystérésis, pour éviter les alertes qui clignotent autour d'un seuil).
- **Sondes** (pour distinguer « agent arrêté » de « Cloud potentiellement inaccessible ») : sur la page de chaque hébergement,
  **Modifier**, champ « URL de sonde » (HTTPS). Le mieux est un petit fichier statique d'un de ses sites (par exemple
  `https://votre-site.fr/ik-probe.txt`, contenant un simple mot) pour ne pas solliciter PHP. Une réponse HTTP inférieure à 500
  (même 404) prouve que le serveur web répond. La page Réglages indique le dernier passage des sondes ; elle signale aussi si
  l'extension **pg_net** doit être activée (Supabase > Database > Extensions).
- **Aucune notification** n'est envoyée : les statuts se consultent dans YellowScope (mise à jour automatique).

## Phase 6 : incidents et historique

- **Menu Incidents** : la liste de tous les incidents (filtres : état, type, Server Cloud). Un badge rouge indique le nombre
  d'incidents en cours. Chaque Cloud affiche aussi ses derniers incidents.
- **Ouverture automatique** : dès qu'un Cloud passe en Warning/Critical, ou qu'il / son agent cesse d'envoyer des données, un
  incident s'ouvre tout seul ; il se clôt seul quand tout est redevenu normal depuis quelques minutes.
- **Page d'un incident** : résumé (début, fin, durée, gravité maximale), raisons, valeurs maximales, chronologie, courbes de la
  période (zone colorée = incident) et une **note** libre pour garder l'explication (par exemple « plugin désactivé »).
- **Réglages > Clôture des incidents** : délai de stabilité avant clôture (5 min par défaut). Si la situation se dégrade de
  nouveau avant la clôture, c'est le même incident qui reprend.
- Les courbes de la page d'un Cloud montrent aussi les incidents en bandes colorées.
- **Mise en ligne** : la migration `…0008_incidents.sql` est appliquée automatiquement par GitHub Actions après « push main ».
- Aucune notification externe : tout se consulte dans YellowScope.

## Phase 7 : trafic (top domaines, détail des logs) et nouvelle interface

1. **Mettre à jour l'agent sur les 6 hébergements** (version 0.3.1) : relancez la commande d'installation (page de
   l'hébergement, voir « Mettre à jour un agent déjà installé »). À la question du token, appuyez sur **Entrée**.
2. Attendez 2 à 3 minutes : l'agent analyse l'`access.log` chaque minute, comme le load (la toute première analyse ne fait que
   se positionner à la fin du fichier). Le classement de la première page porte par défaut sur les 15 dernières minutes
   (bouton « 1 h » pour élargir). Ensuite la première page affiche, pour chaque Cloud : les hébergements classés par
   trafic, puis les domaines les plus sollicités.
3. **Trouver le coupable potentiel** : bandeau du haut (quel Cloud, quel motif) → panneau du Cloud (mesures en orange /
   rouge) → hébergement le plus sollicité → domaine (clic) → page de l'hébergement : requêtes par tranche de 5 minutes,
   erreurs, URL les plus demandées (par exemple `/wp-login.php`), adresses IP, robots. Cliquer un domaine filtre les URL.
4. La page d'un incident (performance, disque) affiche le trafic reçu pendant l'incident : hébergements et domaines
   « potentiellement impliqués ». Il est figé à la clôture, donc consultable après la purge de 3 jours.
5. **Charge sur vos serveurs** : l'agent lit seulement les lignes ajoutées depuis la minute précédente (4 Mo maximum, 1 Mo si
   le serveur est déjà très chargé), avec 3 processus très courts, en priorité minimale. Vérifiez à tout moment :
   `~/.ik-monitor/ik-agent.sh --dry-run`.
6. **Données conservées** : détail (domaines, URL, IP) 3 jours, total par domaine et par heure 30 jours. Aucune ligne de log
   brute n'est envoyée ni stockée.
7. Migration `…0009_traffic.sql` : appliquée par GitHub Actions après « push main ».

## Phase 8 : exploitation, mobile / tablette / TV

- **Réglages** affiche maintenant l'état des **tâches planifiées** et le **stockage de la base** (quota Free de 500 Mo). Une pastille orange
  « Système : … à vérifier » apparaît dans l'en-tête seulement si quelque chose est en retard ou si le quota approche.
- **Mobile et tablette** : la navigation passe sur sa propre ligne, les boutons sont plus grands au toucher, les mesures s'adaptent à la largeur.
- **Mode TV** : menu **Mode TV** (ou `/tv`). Plein écran sans bouton, écran maintenu allumé, curseur masqué. Idéal pour une TV Full HD ou 4K.
- **Mode d'emploi** : `docs/RUNBOOK.md` (que faire si un Cloud est offline, si un agent se tait, si le stockage grimpe, etc.).
- Migration `…0010_storage_stats.sql` : appliquée par GitHub Actions après « push main ».

## Phase 9 : utilisateurs, double authentification (Google Authenticator), non-indexation

**Avant de mettre en ligne (« push main ») — 3 réglages Supabase, sinon vous risquez de ne plus pouvoir vous connecter :**
1. **Authentication > Sign In / Providers** (ou *Multi-Factor*) : la double authentification **TOTP** doit être **activée** (« Enroll » et « Verify »). C'est le cas par défaut sur les projets récents ; vérifiez.
2. **Authentication > URL Configuration** : *Site URL* = l'adresse du site (`https://yellowscope.netlify.app`) ; dans *Redirect URLs*, ajoutez `https://yellowscope.netlify.app/bienvenue`.
3. **Authentication > Sign In / Providers > Email** : laissez **« Allow new users to sign up » désactivé** (invitation seulement). Les e-mails d'invitation utilisent le modèle « Invite user » (personnalisable dans Authentication > Email Templates).

**Ce qui se passe à la mise en ligne**
- La migration `…0011_users_mfa.sql` (via GitHub Actions) exige un code TOTP validé pour lire les données, puis la fonction Edge `manage-users` est déployée par la même action (elle utilise la clé de service **fournie par Supabase à l'exécution**, jamais stockée dans le dépôt).
- À votre prochaine ouverture du site : connexion e-mail + mot de passe, puis **création de votre double authentification** (scannez le QR code avec Google Authenticator, saisissez le code). Gardez la clé affichée sous le QR code dans votre gestionnaire de mots de passe pour pouvoir la recréer.
- Menu **Utilisateurs** : inviter des personnes, changer les rôles, réinitialiser un 2FA, supprimer un compte (voir `docs/RUNBOOK.md`).
- Le site est **non indexé** : `X-Robots-Tag: noindex…` sur toutes les pages, balise `meta robots` et `robots.txt` (`Disallow: /`). Aucun moteur de recherche respectueux des règles ne l'affichera.

## Phase 10 : notifications Slack

1. Créez l'adresse d'un **webhook entrant** Slack (les étapes sont aussi dans la carte de Réglages) : `api.slack.com/apps` > *Create New App* > *From scratch* > *Incoming Webhooks* > activer > *Add New Webhook to Workspace* > choisir le canal > copier l'adresse `https://hooks.slack.com/services/…`.
2. **Réglages > Notifications Slack** : collez l'adresse (elle n'est **jamais réaffichée**, seuls ses 4 derniers caractères le sont), choisissez le niveau (recommandé : *Critical seulement*), le rappel (toutes les 30 minutes tant que c'est Critical), cochez **Activer**, **Enregistrer**, puis **Envoyer un message de test**.
3. Règles : alerte à l'ouverture, l'escalade ou la rechute d'un incident qui atteint le niveau choisi ; message de **retour à la normale** à la clôture (seulement si une alerte avait été envoyée) ; rappels périodiques tant que l'incident reste Critical ; **aucune notification en mode maintenance**. Le message donne le motif (valeurs et seuils), les domaines les plus sollicités (« potentiellement impliqués ») et un lien vers l'incident.
4. Les envois passent par **pg_net** (déjà requis pour les sondes) et **pg_cron** (chaque minute), avec 3 tentatives ; l'historique des derniers envois est dans la même carte.
5. Migration `…0013_slack_notifications.sql` : appliquée par GitHub Actions après « push main ».

