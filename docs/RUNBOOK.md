# Mode d'emploi d'exploitation (runbook)

Ce document répond à « que faire quand… ». Il est écrit pour être suivi sans connaissance technique : chaque cas donne
ce que vous voyez, ce que cela veut dire, puis les gestes à faire dans l'ordre.

## 1. Qui fait quoi

| Élément | Rôle | Où le gérer |
|---|---|---|
| **Agent** (`~/.ik-monitor/`) | Petit script lancé chaque minute sur chaque hébergement : envoie load/CPU/RAM/disque (collecteur) et le trafic | SSH sur l'hébergement |
| **Supabase** | Base de données, évaluation des statuts, tâches planifiées | supabase.com > votre projet |
| **Netlify** | Publie le site (et l'agent téléchargeable) | app.netlify.com |
| **GitHub** | Le code ; « push main » = mise en ligne (site + base) | github.com > Actions |

## 2. Contrôle quotidien (30 secondes)

1. Ouvrez la première page. Le **bandeau du haut** doit dire « Tout est normal » (vert).
2. Regardez l'en-tête : pas de pastille orange **« Système : … à vérifier »** (tâches planifiées, stockage).
3. Le badge rouge à côté de **Incidents** indique le nombre d'incidents en cours.
4. Les versions d'agent (petit texte à côté des hébergements) sont toutes **grises** ; une version **orange** est à mettre à jour.

## 3. Symptômes et gestes

### Un Server Cloud est « Offline »
1. Ouvrez le Cloud : la carte « Statut » donne un diagnostic prudent (agents silencieux / aucun agent ne répond / sondes en échec).
2. **Agents silencieux, sondes qui répondent** : le serveur va probablement bien, ce sont les agents qui n'envoient plus. Passez au cas suivant.
3. **Aucun agent ne répond et sondes en échec** : le Cloud est potentiellement inaccessible. Vérifiez la console Infomaniak (état du serveur), puis un site du Cloud dans un navigateur.
4. Maintenance prévue ? Activez le **mode maintenance** du Cloud (page du Cloud > Modifier) : plus aucune alerte ni incident pendant ce temps.

### Un agent est « silencieux » ou « non installé » (accueil)
1. SSH sur l'hébergement, puis : `crontab -l` (doit contenir une ligne `ik-monitor`), `cat ~/.ik-monitor/agent.log`.
2. `~/.ik-monitor/ik-agent.sh --verbose` : envoie un heartbeat et affiche le résultat.
3. Message « authentification refusée » : le token est révoqué ou changé ; régénérez-le (page de l'hébergement) et relancez l'installation avec le nouveau token.
4. Rien ne va : relancez l'installation (bouton **Mettre à jour l'agent** ; Entrée conserve le token).

### « Aucune donnée » sur un Cloud
Aucun agent **collecteur** n'envoie de relevés. Page du Cloud > hébergements : un seul est « collecteur système ». Vérifiez son agent (cas précédent) ou désignez un autre collecteur (« Définir comme collecteur »).

### Les domaines les plus sollicités restent vides
1. Version de l'agent ≥ 0.3.1 ? (accueil, texte à côté du nom ; sinon **Mettre à jour l'agent**).
2. Le fichier `~/ik-logs/access.log` existe-t-il ? `ls -l ~/ik-logs/access.log`.
3. `grep '^tr_' ~/.ik-monitor/state` doit afficher `tr_off`, `tr_ino`, `tr_ts`. La première analyse ne fait que se positionner ; les données arrivent à la suivante (1 minute).
4. `grep -o '"traffic_accepted":[0-9]*' ~/.ik-monitor/response` : 1 ou plus = le serveur reçoit.

### Un statut ne bouge plus / pastille « Système : … à vérifier »
Réglages > **Tâches planifiées** : une ligne « En retard » ou « Pas encore exécutée ». Cause habituelle : l'extension **pg_cron** n'est pas active.
1. Supabase > Database > Extensions > activez **pg_cron** (et **pg_net** pour les sondes).
2. Rejouez la planification : GitHub > Actions > « Déployer les migrations » > *Re-run all jobs*, ou dites-le-moi pour que je le fasse.

### Le stockage approche du quota (Réglages > Stockage de la base)
1. Orange à 70 %, rouge à 90 % du quota Free (500 Mo).
2. Réduire les conservations : détail du trafic 3 jours, mesures 35 jours. Dans Supabase > SQL Editor :
   `select public.purge_old_data(20, 60); select public.purge_traffic(2, 14);` (les garde-fous refusent en dessous de 8 jours / 35 jours pour les mesures et de 2 / 7 jours pour le trafic).
3. Ou passer à l'offre Pro de Supabase (puis adapter `DB_QUOTA_BYTES` dans `apps/web/src/lib/health.ts`).

### « Connexion perdue · nouvelle tentative automatique »
Le navigateur ne joint plus Supabase. Vérifiez votre connexion ; si tout le monde est touché, regardez status.supabase.com. La page se rétablit toute seule.

### Les sondes HTTP sont en erreur (Réglages)
Le message précise la cause. « pg_net » : activez l'extension (voir plus haut). Une sonde n'est utile que si l'URL de l'hébergement est renseignée (page de l'hébergement > Modifier > URL de sonde).

## 4. Procédures

### Installer l'agent sur un nouvel hébergement
1. YellowScope : ajouter le Cloud puis l'hébergement ; **Générer le token** ; copier la commande d'installation.
2. SSH sur l'hébergement : coller les deux lignes ; coller le token à la question (saisie invisible).
3. 2 minutes plus tard : « État de l'agent » affiche un heartbeat récent.

### Mettre à jour un agent
Page de l'hébergement > **Mettre à jour l'agent** > copier la commande > SSH > coller > **Entrée** au token.

### Désinstaller un agent
SSH : `bash ik-install.sh --uninstall` (retire la ligne de cron et le dossier `~/.ik-monitor`). Puis **Révoquer** le token sur la page de l'hébergement.

### Changer le collecteur système d'un Cloud
Page de l'hébergement souhaité > **Définir comme collecteur**. Aucune réinstallation : l'agent l'apprend au heartbeat suivant.

### Renouveler un token (suspicion de fuite, départ d'un prestataire)
1. Page de l'hébergement > **Régénérer** (délai de grâce possible pour laisser l'ancien token valable quelques minutes).
2. Mettre à jour l'agent avec le nouveau token (relancer l'installation, coller le nouveau token).
3. Ne collez jamais un token dans un ticket, un mail ou une conversation.

### Ajuster les seuils d'alerte
Réglages > seuils par défaut, ou page d'un Cloud > seuils propres à ce Cloud. Comparez avec les mesures des 7 derniers jours affichées sous chaque règle avant de valider.

### Inviter, modifier ou retirer un utilisateur
Menu **Utilisateurs** (propriétaires seulement) :
- **Inviter** : e-mail + rôle (Lecteur = consultation ; Propriétaire = tous les droits). La personne reçoit un e-mail, choisit son mot de passe (12 caractères minimum) puis configure Google Authenticator.
- **Changer le rôle** : menu déroulant de la ligne (le dernier propriétaire ne peut pas être rétrogradé).
- **Réinitialiser le 2FA** : pour quelqu'un qui a perdu ou changé de téléphone ; il en recréera un à sa prochaine connexion.
- **Supprimer** : retire le compte et tous ses accès. Vous ne pouvez pas vous supprimer vous-même.
- Une invitation qui n'arrive pas : vérifiez les indésirables, puis Supabase > Authentication > Logs. L'offre Free limite le nombre d'e-mails envoyés par heure ; un serveur SMTP personnel (Project Settings > Authentication > SMTP) lève la limite.

### Connexion et double authentification (2FA)
- Chaque connexion demande : e-mail + mot de passe, puis le code à 6 chiffres de l'application d'authentification. La base **refuse toute donnée** à une session sans code validé.
- **Mot de passe oublié** : lien sur la page de connexion (l'e-mail contient un lien vers la page « Choisissez votre mot de passe »).
- **Téléphone perdu** : un autre propriétaire réinitialise votre 2FA (menu Utilisateurs). Si vous êtes le **seul** propriétaire : Supabase > Authentication > Users > votre utilisateur > supprimer le facteur (Factors), puis reconnectez-vous.
- **Changement de téléphone (ancien encore utilisable)** : Mon compte > Réinitialiser mon double facteur.
- Les invitations et réinitialisations expirent : demandez-en un nouveau lien si « Lien expiré ».

## 5. Sécurité

- Le dépôt ne contient aucun secret : la clé publique Supabase (`anon`) est volontairement publique ; la clé **secrète** (`service_role`) ne doit apparaître nulle part. Si une clé secrète a été copiée dans une conversation ou un document : Supabase > Project Settings > API Keys > la révoquer / la régénérer.
- Chaque agent a **son** token ; il ne peut écrire que pour son hébergement. Seule l'empreinte (hash) est stockée.
- Les adresses IP des visiteurs (top du trafic) ne sont conservées que **3 jours** ; aucune ligne de log brute n'est envoyée.
- Accès **uniquement sur invitation** (inscription publique désactivée) avec **double authentification obligatoire** (TOTP), imposée par la base elle-même (RLS) et non seulement par l'interface.
- Le site est **non indexé** par les moteurs de recherche (en-tête `X-Robots-Tag`, balise `meta robots` et `robots.txt`).
- Le site impose HTTPS, une politique CSP stricte et refuse d'être affiché dans un cadre (voir `netlify.toml`).

## 6. Sauvegarde

L'offre Supabase Free ne garantit pas de sauvegarde automatique restaurable : **vérifiez** dans Supabase > Database > Backups ce que votre offre inclut. Les données importantes à long terme sont peu nombreuses (inventaire, seuils, incidents) ; un export ponctuel est possible dans SQL Editor (ou `pg_dump` avec l'URL de connexion du projet). Les mesures et le trafic sont reconstruits par les agents et n'ont pas à être restaurés.

## 7. Affichage

- **Mobile / tablette** : la navigation défile sur sa propre ligne, les zones de toucher sont agrandies.
- **Mode TV** : menu **Mode TV** (ou adresse `/tv`) : plein écran sans boutons, écran maintenu allumé, curseur masqué. Quitter : bouger la souris puis « Quitter le mode TV ».

## 8. Liste de contrôle avant de considérer la production « stable »

- [x] Les 6 agents affichent une version grise (à jour) et un heartbeat récent.
- [ ] Réglages > Tâches planifiées : toutes « En marche ».
- [ ] Un test réel : arrêter volontairement un agent 5 minutes → le Cloud passe en incident « agent » puis revient et l'incident se clôt seul.
- [ ] Seuils comparés aux 7 jours réels, puis validés.
- [ ] Sondes : URL renseignées, une sonde réussie visible dans la page de l'hébergement.
- [x] Clé secrète Supabase révoquée (fait).
- [ ] Quotas : stockage sous 50 % après une semaine ; au-delà, réduire les conservations.
- [x] Comparaison load/CPU avec la console Infomaniak (test CPU synchronisé sur le Cloud 2 fait).
