#!/usr/bin/env bash
# Tests de l'agent (aucun accès réseau : curl et df sont simulés). Usage : agent/tests/run.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$HERE/../ik-agent.sh"
TOKEN="ikh_0123456789ab_$(printf 'f%.0s' {1..64})"
PASS=0
FAIL=0

check() { # check <description> <commande de test...>
  local desc=$1; shift
  if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "  ÉCHEC : $desc"; fi
}
eq() { [[ "$1" == "$2" ]] || { echo "    attendu : [$2]  obtenu : [$1]"; return 1; }; }
has() { [[ "$1" == *"$2"* ]] || { echo "    [$2] introuvable dans : ${1:0:300}"; return 1; }; }
hasnt() { [[ "$1" != *"$2"* ]] || { echo "    [$2] ne devrait pas apparaître dans : ${1:0:300}"; return 1; }; }

new_env() {
  T="$(mktemp -d)"
  export IK_HOME="$T/home" IK_STATE_DIR="$T/home/.ik-monitor" IK_PROC_DIR="$T/proc"
  export MOCK_LOG="$T/curl.log" MOCK_HDRS="$T/curl.hdrs" MOCK_LAST_BODY="$T/body.json"
  export PATH="$HERE/bin:$PATH"
  unset MOCK_HTTP_CODE MOCK_BODY IK_NOW
  mkdir -p "$IK_HOME/.ik-monitor" "$IK_HOME/ik-logs" "$IK_PROC_DIR"
  : >"$MOCK_LOG"; : >"$MOCK_HDRS"
  head -c 5000 /dev/zero | tr '\0' 'x' >"$IK_HOME/ik-logs/access.log"
  printf 'IK_API_URL=https://example.supabase.co\nIK_API_KEY=sb_publishable_test12345\nIK_TOKEN=%s\n' "$TOKEN" \
    >"$IK_STATE_DIR/config"
  for i in $(seq 0 11); do printf 'processor\t: %d\nmodel name\t: Fake CPU\n\n' "$i"; done >"$IK_PROC_DIR/cpuinfo"
  echo "2.43 3.13 4.12 2/1399 2141210" >"$IK_PROC_DIR/loadavg"
  echo "1234567.89 5555.11" >"$IK_PROC_DIR/uptime"
  printf 'MemTotal:       36960000 kB\nMemFree:         1000000 kB\nMemAvailable:   24736000 kB\nSwapTotal:       4193280 kB\nSwapFree:        4193280 kB\n' \
    >"$IK_PROC_DIR/meminfo"
  mk_stat 1000 0 500 8000 500
}
mk_stat() { # user nice system idle iowait
  printf 'cpu  %d %d %d %d %d 0 0 0 0 0\ncpu0 1 1 1 1 1 0 0 0 0 0\nintr 1\n' "$1" "$2" "$3" "$4" "$5" >"$IK_PROC_DIR/stat"
}
as_collector() { printf 'collector=1\n' >>"$IK_STATE_DIR/state"; }
body() { cat "$MOCK_LAST_BODY"; }
curl_calls() { wc -l <"$MOCK_LOG" | tr -d ' '; }
spool_lines() { local n; n=$(grep -c . "$IK_STATE_DIR/spool" 2>/dev/null); echo "${n:-0}"; }

echo "== Agent : tests"

# --- 1. Premier passage : heartbeat sans relevé, le serveur désigne le collecteur ---------------------
new_env; export MOCK_BODY='{"ok": true, "collector": true, "accepted": 0, "actions": []}'
"$AGENT"
check "heartbeat envoyé" eq "$(curl_calls)" 1
check "aucun point avant désignation" eq "$(body | jq '.points | length')" 0
check "payload JSON valide, v=1" eq "$(body | jq -r '.v')" 1
check "le rôle de collecteur est mémorisé" has "$(cat "$IK_STATE_DIR/state")" "collector=1"

# --- 2. Collecteur : premier relevé, CPU non calculable -----------------------------------------------
new_env; as_collector; export IK_NOW=1000000 MOCK_BODY='{"ok": true, "collector": true, "actions": []}'
"$AGENT"
check "1 point envoyé" eq "$(body | jq '.points | length')" 1
check "cpu_pct nul au premier relevé" eq "$(body | jq -c '.points[0].cpu_pct')" null
check "load 1m" eq "$(body | jq '.points[0].load[0]')" 2.43
check "cœurs comptés dans /proc/cpuinfo" eq "$(body | jq '.points[0].cpu_cores')" 12
check "RAM totale en Mo" eq "$(body | jq '.points[0].mem.total_mb')" 36093
check "RAM disponible en Mo" eq "$(body | jq '.points[0].mem.avail_mb')" 24156
check "RAM utilisée = total - disponible" eq "$(body | jq '.points[0].mem.used_mb')" 11937
check "swap total en Mo" eq "$(body | jq '.points[0].swap.total_mb')" 4095
check "swap utilisé" eq "$(body | jq '.points[0].swap.used_mb')" 0
check "disque total en Mo" eq "$(body | jq '.points[0].disk.total_mb')" 281589
check "périphérique disque" eq "$(body | jq -r '.points[0].disk.device')" "/dev/mapper/vgdata-client"
check "uptime en secondes" eq "$(body | jq '.points[0].uptime_s')" 1234567
check "taille du log remontée" eq "$(body | jq '.agent.log.size')" 5000
check "spool vidé après succès" eq "$(spool_lines)" 0

# --- 3. CPU % calculé à partir de deux relevés (Δtotal=1000, Δidle+iowait=800 → 20,0 %) --------------
mk_stat 1150 0 550 8750 550; export IK_NOW=1000060
"$AGENT"
check "cpu_pct = 20.0 sur deux relevés successifs" eq "$(body | jq '.points[0].cpu_pct == 20')" true

# --- 4. Compteurs qui reculent (redémarrage) ⇒ pas de valeur inventée ---------------------------------
mk_stat 10 0 5 80 5; export IK_NOW=1000120
"$AGENT"
check "cpu_pct nul si les compteurs reculent" eq "$(body | jq -c '.points[0].cpu_pct')" null

# --- 5. Trop long silence entre deux relevés ⇒ CPU non fiable ------------------------------------------
mk_stat 1000 0 500 8000 500; export IK_NOW=1000180; "$AGENT"
mk_stat 1150 0 550 8750 550; export IK_NOW=1000600
"$AGENT"
check "cpu_pct nul après plus de 5 min d'écart" eq "$(body | jq -c '.points[0].cpu_pct')" null

# --- 6. Panne réseau : le spool conserve les relevés, puis renvoi en lot ------------------------------
new_env; as_collector; export MOCK_HTTP_CODE=500 MOCK_BODY='{"message":"boom"}'
export IK_NOW=2000000; "$AGENT"
export IK_NOW=2000060; "$AGENT"
check "2 relevés conservés en spool" eq "$(spool_lines)" 2
export MOCK_HTTP_CODE=200 MOCK_BODY='{"ok": true, "collector": true, "actions": []}' IK_NOW=2000120
"$AGENT"
check "renvoi en lot : 3 points (2 en attente + 1 nouveau)" eq "$(body | jq '.points | length')" 3
check "les points sont dans l'ordre chronologique" eq "$(body | jq -c '[.points[].ts]')" "[2000000,2000060,2000120]"
check "backlog signalé" eq "$(body | jq '.agent.backlog')" 3
check "spool vidé après le renvoi" eq "$(spool_lines)" 0

# --- 7. Spool plafonné à 30 relevés -------------------------------------------------------------------
new_env; as_collector; export MOCK_HTTP_CODE=000 IK_NOW=3000000
for i in $(seq 1 35); do IK_NOW=$((3000000 + i * 60)) "$AGENT"; done
check "spool plafonné à 30" eq "$(spool_lines)" 30
check "les plus anciens sont abandonnés" eq "$(head -1 "$IK_STATE_DIR/spool" | jq '.ts')" $((3000000 + 6 * 60))
check "taille du payload sous la limite serveur (16 Ko après ré-encodage jsonb)" \
  eq "$( (( $(body | jq -c . | wc -c) < 12000 )) && echo ok)" ok

# --- 8. Erreurs d'authentification : journal une seule fois, spool conservé, jamais de token en argument
new_env; as_collector; export MOCK_HTTP_CODE=401 MOCK_BODY='{"message":"unauthorized"}'
export IK_NOW=4000000; "$AGENT"; export IK_NOW=4000060; "$AGENT"; export IK_NOW=4000120; "$AGENT"
check "erreur 401 journalisée une seule fois" eq "$(grep -c "authentification refusee" "$IK_STATE_DIR/agent.log")" 1
check "relevés conservés malgré le 401" eq "$(spool_lines)" 3
check "le token n'apparaît jamais dans les arguments de curl" hasnt "$(cat "$MOCK_LOG")" "ikh_"
check "le token est transmis par fichier d'en-têtes" has "$(cat "$MOCK_HDRS")" "x-agent-token: $TOKEN"
check "connexion HTTPS sur le bon point d'entrée" has "$(cat "$MOCK_LOG")" "https://example.supabase.co/rest/v1/rpc/agent_heartbeat"
check "délais d'attente réseau présents" has "$(cat "$MOCK_LOG")" "--max-time 10"
check "l'erreur est remontée au serveur" has "$(body)" "authentification refusee"
export MOCK_HTTP_CODE=200 MOCK_BODY='{"ok": true, "collector": true, "actions": []}' IK_NOW=4000180; "$AGENT"
check "reprise journalisée" has "$(cat "$IK_STATE_DIR/agent.log")" "envois rétablis"
check "le 1er envoi réussi signale encore l'erreur précédente" has "$(body)" "authentification refusee"
export IK_NOW=4000240; "$AGENT"
check "plus d'erreur ensuite" eq "$(body | jq -c '.agent.last_error')" null

# --- 8b. Erreur d'API : le message du serveur est journalisé (diagnostic) --------------------------------
new_env; as_collector
export MOCK_HTTP_CODE=404 MOCK_BODY='{"code":"PGRST202","message":"Could not find the function public.agent_heartbeat(agent, v) in the schema cache"}'
export IK_NOW=4500000; "$AGENT"
check "le message de l'API est journalisé" has "$(cat "$IK_STATE_DIR/agent.log")" "HTTP 404 - Could not find the function public.agent_heartbeat"
check "aucun en-tête Prefer inutile" eq "$([[ $(cat "$MOCK_LOG") == *Prefer* ]] && echo yes || echo no)" no

# --- 9. Le serveur retire le rôle de collecteur ---------------------------------------------------------
new_env; as_collector; export IK_NOW=5000000 MOCK_BODY='{"ok": true, "collector": false, "actions": []}'
"$AGENT"
check "rôle retiré mémorisé" has "$(cat "$IK_STATE_DIR/state")" "collector=0"
export IK_NOW=5000060; "$AGENT"
check "plus aucun point envoyé après retrait du rôle" eq "$(body | jq '.points | length')" 0

# --- 10. Configuration invalide : aucun envoi, erreur journalisée une fois ------------------------------
new_env; as_collector
sed -i 's|https://|http://|' "$IK_STATE_DIR/config"
"$AGENT"; "$AGENT"
check "URL non HTTPS refusée : aucun appel réseau" eq "$(curl_calls)" 0
check "erreur de configuration journalisée une fois" eq "$(grep -c "HTTPS obligatoire" "$IK_STATE_DIR/agent.log")" 1
new_env; sed -i 's|^IK_TOKEN=.*|IK_TOKEN=pas-un-token|' "$IK_STATE_DIR/config"; "$AGENT"
check "token de format invalide refusé" eq "$(curl_calls)" 0

# --- 11. Mode --dry-run : aucun appel réseau, JSON valide -----------------------------------------------
new_env; as_collector
out="$("$AGENT" --dry-run | tail -1)"
check "dry-run : aucun appel réseau" eq "$(curl_calls)" 0
check "dry-run : JSON valide" eq "$(printf '%s' "$out" | jq -r '.agent_version')" "0.3.1"
check "dry-run : ne remplit pas le spool" eq "$(spool_lines)" 0

# --- 12. Verrou : une exécution déjà en cours empêche le chevauchement ----------------------------------
new_env; as_collector
bash -c 'exec -a ik-agent sleep 30' & holder=$!
sleep 0.3; printf '%s\n' "$holder" >"$IK_STATE_DIR/lock"
mkdir -p "$T/proc/$holder" && printf 'ik-agent\0' >"$T/proc/$holder/cmdline"
"$AGENT"
check "verrou actif : pas de chevauchement" eq "$(curl_calls)" 0
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
printf '99999999\n' >"$IK_STATE_DIR/lock"
"$AGENT"
check "verrou orphelin ignoré" eq "$(curl_calls)" 1

# --- 13. Robustesse : /proc illisible ⇒ pas de crash, pas de point ---------------------------------------
new_env; as_collector; rm "$IK_PROC_DIR/meminfo"
"$AGENT"
check "sans meminfo : heartbeat quand même envoyé, sans point" eq "$(body | jq '.points | length')" 0
check "avertissement journalisé" has "$(cat "$IK_STATE_DIR/agent.log")" "inutilisable"

# --- 14. Fichiers sensibles en 600 / dossier en 700 -----------------------------------------------------
new_env; as_collector; "$AGENT"
check "en-têtes (token) non lisibles par les autres" eq "$(stat -c '%a' "$IK_STATE_DIR/headers")" 600

# --- 15. Découverte des sites : noms des dossiers de ~/sites ------------------------------------------------
new_env; export MOCK_BODY='{"ok": true, "collector": false, "actions": []}'
mkdir -p "$IK_HOME/sites"/{Exemple.FR,blog.exemple.fr,default,tmp,192.168.0.1,a_b.fr,-x.fr} "$IK_HOME/sites/plus-tard.com"
: >"$IK_HOME/sites/readme.txt"
export IK_NOW=6000000; "$AGENT"
check "les dossiers qui ressemblent à des domaines sont remontés (minuscules, bruit écarté)" \
  eq "$(body | jq -c '.domains | sort')" '["blog.exemple.fr","exemple.fr","plus-tard.com"]'
check "un fichier ordinaire n'est pas un site" eq "$(body | jq '.domains | index("readme.txt")')" null
export IK_NOW=6000060; "$AGENT"
check "liste inchangée : pas renvoyée à la minute suivante" eq "$(body | jq 'has("domains")')" false
mkdir -p "$IK_HOME/sites/nouveau-site.fr"; export IK_NOW=6000120; "$AGENT"
check "un nouveau dossier déclenche un renvoi immédiat" eq "$(body | jq '.domains | length')" 4
export IK_NOW=$((6000120 + 21600 + 60)); "$AGENT"
check "liste renvoyée au moins toutes les 6 h" eq "$(body | jq '.domains | length')" 4

new_env; mkdir -p "$IK_HOME/sites/exemple.fr"; export MOCK_HTTP_CODE=500 IK_NOW=6100000
"$AGENT"; export IK_NOW=6100060; "$AGENT"
check "envoi échoué : la liste des sites est renvoyée à la minute suivante" eq "$(body | jq '.domains | length')" 1

new_env; as_collector; mkdir -p "$IK_HOME/sites/exemple.fr"; export MOCK_HTTP_CODE=000 IK_NOW=6200000
for i in $(seq 1 8); do IK_NOW=$((6200000 + i * 60)) "$AGENT"; done
check "spool de plus de 5 relevés : la liste des sites n'est pas jointe" eq "$(body | jq 'has("domains")')" false

new_env; "$AGENT"
check "sans dossier sites : aucune clé « domains »" eq "$(body | jq 'has("domains")')" false
new_env; mkdir -p "$IK_HOME/sites/exemple.fr"
out="$("$AGENT" --dry-run | tail -1)"
check "dry-run : la liste des sites est visible" eq "$(printf '%s' "$out" | jq -c '.domains')" '["exemple.fr"]'
new_env; for i in $(seq 1 230); do mkdir -p "$IK_HOME/sites/site$i.fr"; done; "$AGENT"
check "plafond de 200 sites par envoi" eq "$(body | jq '.domains | length')" 200

# --- Trafic : analyse de l'access.log --------------------------------------------------------------------
mk_log() { # mk_log <nb de lignes> : lignes d'access.log réalistes sur deux domaines + bruit
  local i
  for ((i = 0; i < $1; i++)); do
    printf 'www.exemple.fr 203.0.113.9 - - [30/Sep/2026:09:07:39 +0200] "POST /wp-login.php?redirect_to=x&y=1 HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (X11) Firefox/149"\n'
    printf 'autre.fr 66.249.79.161 - - [30/Sep/2026:09:07:40 +0200] "GET /shop/produit/ HTTP/1.1" 503 58 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"\n'
  done
}
new_env; export IK_NOW=7000000; "$AGENT"
check "première analyse : aucun historique relu" eq "$(body | jq 'has("traffic")')" false
check "décalage initial = taille du fichier" has "$(cat "$IK_STATE_DIR/state")" "tr_off=5000"
: >"$IK_HOME/ik-logs/access.log"; mk_log 10 >>"$IK_HOME/ik-logs/access.log"
export IK_NOW=7000030; "$AGENT"
check "moins de 55 s après la précédente : pas d'analyse" eq "$(body | jq 'has("traffic")')" false
export IK_NOW=7000060; "$AGENT"
check "fenêtre de trafic envoyée (analyse chaque minute)" eq "$(body | jq '.traffic | length')" 1
check "total de requêtes" eq "$(body | jq '.traffic[0].n')" 20
check "domaines regroupés (www. retiré)" eq "$(body | jq -c '[.traffic[0].d[].h] | sort')" '["autre.fr","exemple.fr"]'
check "erreurs 5xx comptées" eq "$(body | jq '.traffic[0].s[3]')" 10
check "POST comptés" eq "$(body | jq '.traffic[0].m')" 10
check "Googlebot reconnu" eq "$(body | jq '.traffic[0].ua.g')" 10
check "navigateurs comptés" eq "$(body | jq '.traffic[0].ua.h')" 10
check "URL : la requête est réduite au nom du premier paramètre" eq "$(body | jq -r '[.traffic[0].u[].p] | sort | .[0]')" "/shop/produit/"
check "URL avec paramètre sans valeur" has "$(body | jq -r '[.traffic[0].u[].p] | join(" ")')" "/wp-login.php?redirect_to"
check "IP active remontée" has "$(body | jq -r '[.traffic[0].i[].ip] | join(" ")')" "203.0.113.9"
check "aucune ligne brute dans le message" hasnt "$(body)" "Mozilla"
check "fenêtre acquittée : plus rien en attente" eq "$(grep -c . "$IK_STATE_DIR/traffic" 2>/dev/null || true)" 0
export IK_NOW=7000120; "$AGENT"
check "rien de nouveau dans le log : pas de fenêtre" eq "$(body | jq 'has("traffic")')" false

# Envoi échoué : la fenêtre reste en attente, renvoyée ensuite (3 au plus).
new_env; export IK_NOW=7100000; "$AGENT"
mk_log 3 >>"$IK_HOME/ik-logs/access.log"; export MOCK_HTTP_CODE=500 IK_NOW=7100300; "$AGENT"
check "HTTP 500 : la fenêtre est conservée" eq "$(grep -c . "$IK_STATE_DIR/traffic")" 1
mk_log 3 >>"$IK_HOME/ik-logs/access.log"; export IK_NOW=7100600; "$AGENT"
mk_log 3 >>"$IK_HOME/ik-logs/access.log"; export IK_NOW=7100900; "$AGENT"
mk_log 3 >>"$IK_HOME/ik-logs/access.log"; export IK_NOW=7101200; "$AGENT"
check "au plus 3 fenêtres en attente" eq "$(grep -c . "$IK_STATE_DIR/traffic")" 3
unset MOCK_HTTP_CODE; export IK_NOW=7101260; "$AGENT"
check "rétabli : les 3 fenêtres partent ensemble" eq "$(body | jq '.traffic | length')" 3
check "puis la file est vidée" eq "$(grep -c . "$IK_STATE_DIR/traffic" 2>/dev/null || true)" 0

# Rotation du log (nouvel inode, fichier plus petit) : on relit le nouveau fichier depuis le début.
new_env; export IK_NOW=7200000; "$AGENT"
rm "$IK_HOME/ik-logs/access.log"; mk_log 2 >"$IK_HOME/ik-logs/access.log"; export IK_NOW=7200300; "$AGENT"
check "après rotation : nouveau fichier analysé depuis le début" eq "$(body | jq '.traffic[0].n')" 4

# Fichier volumineux : seule la fin (plafond) est lue, et signalée « trunc ».
new_env; export IK_NOW=7300000; "$AGENT"
mk_log 200000 >>"$IK_HOME/ik-logs/access.log"
export IK_NOW=7300300; "$AGENT"
check "log énorme : lecture plafonnée et marquée tronquée" eq "$(body | jq '.traffic[0].trunc')" 1
check "log énorme : moins de lignes que dans le fichier" eq "$(body | jq '.traffic[0].n < 400000')" true
check "message de trafic borné" eq "$(body | jq -c '.traffic[0]' | wc -c | awk '{print ($1 < 12000)}')" 1

# Lignes illisibles et domaines hostiles : comptées « bad » ou regroupées, jamais injectées dans le JSON.
new_env; export IK_NOW=7400000; "$AGENT"
{ printf 'n importe quoi\n'; printf 'evil"host 1.2.3.4 - - [x] "GET /a\\"b HTTP/1.1" 200 5 "-" "ua"\n'
  printf 'ok.fr 1.2.3.4 - - [x] "GET /ok?q=<script> HTTP/1.1" 200 5 "-" "curl/8"\n'; } >>"$IK_HOME/ik-logs/access.log"
export IK_NOW=7400300; "$AGENT"
check "corps toujours du JSON valide" eq "$(body | jq -e '.traffic[0].d' >/dev/null 2>&1; echo $?)" 0
check "ligne illisible comptée" eq "$(body | jq '.traffic[0].bad >= 1')" true
check "robot générique reconnu (curl)" eq "$(body | jq '.traffic[0].ua.b')" 1
check "caractères dangereux d'une URL neutralisés" eq "$(body | jq -r '[.traffic[0].u[].p] | map(select(test("[<>\"]"))) | length')" 0

# Sans access.log : pas d'erreur, pas de trafic.
new_env; rm -f "$IK_HOME/ik-logs/access.log"; export IK_NOW=7500000; "$AGENT"; export IK_NOW=7500300; "$AGENT"
check "sans access.log : heartbeat normal" eq "$(body | jq 'has("traffic")')" false

echo
echo "Résultat : $PASS réussis, $FAIL échoués"
((FAIL == 0))
