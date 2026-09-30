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
4. **Importer des domaines** : collez la liste des sites de l'hébergement (un par ligne). Utilisez le nom tel
   qu'il apparaît dans le premier champ de `~/ik-logs/access.log` (avec `www.` si c'est le cas).
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
