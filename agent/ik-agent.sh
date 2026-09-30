#!/usr/bin/env bash
# YellowScope – agent de supervision pour hébergements Infomaniak.
#
# Lancé chaque minute par cron, sans privilège root, sans démon, sans dépendance hors curl.
#   * collecte les métriques système (uniquement si le serveur l'a désigné « collecteur ») ;
#   * envoie un heartbeat HTTPS ; conserve les relevés localement si l'envoi échoue (spool) ;
#   * n'exécute JAMAIS de commande reçue de l'API.
#
# Conçu pour consommer très peu : lecture de /proc par builtins Bash, un seul fork obligatoire
# (curl) en fonctionnement normal, df / stat seulement toutes les 5 minutes.
#
# Usage : ik-agent.sh [--verbose] [--dry-run] | --version | --help
set -u

readonly AGENT_VERSION="0.2.0"
readonly MAX_SPOOL=30
readonly SLOW_REFRESH_S=300     # df / stat / cœurs : toutes les 5 minutes
readonly MAX_CPU_GAP_S=300      # au-delà, l'écart entre deux relevés rend le CPU % trompeur
readonly MAX_DOMAINS=200        # sites remontés au plus (dossiers de ~/sites)
readonly DOMAINS_EVERY_S=21600  # liste des sites renvoyée au moins toutes les 6 heures (ou dès qu'elle change)

export LC_ALL=C
export PATH="${PATH:-/usr/bin:/bin}:/usr/local/bin:/usr/bin:/bin"
umask 077

PROC="${IK_PROC_DIR:-/proc}"
BASE="${IK_HOME:-${HOME:-}}"
DIR="${IK_STATE_DIR:-$BASE/.ik-monitor}"
CONFIG="$DIR/config"
STATE="$DIR/state"
SPOOL="$DIR/spool"
LOGFILE="$DIR/agent.log"
HDR="$DIR/headers"
RESP="$DIR/response"
CURL_ERR="$DIR/curl.err"
LOCK="$DIR/lock"

VERBOSE=0
DRYRUN=0
IK_API_URL="" IK_API_KEY="" IK_TOKEN="" IK_LOG_PATH="" IK_SITES_DIR=""
declare -A S=()
declare -a spool=()

# ---------------------------------------------------------------------------------------------------
# Journal : uniquement lors d'un changement d'état, fichier plafonné.
# ---------------------------------------------------------------------------------------------------
log() {
  local ts size
  printf -v ts '%(%Y-%m-%dT%H:%M:%S%z)T' -1
  ((VERBOSE)) && printf '%s %s\n' "$ts" "$*"
  [[ -d $DIR ]] || return 0
  if [[ -f $LOGFILE ]]; then
    size=$(wc -c <"$LOGFILE" 2>/dev/null || echo 0)
    ((size > 51200)) && : >"$LOGFILE"
  fi
  printf '%s %s\n' "$ts" "$*" >>"$LOGFILE" 2>/dev/null
  return 0
}

# Ne journalise que si le message diffère du précédent (évite 1 440 lignes/jour pendant une panne).
ERR_NOW=""
note_error() { ERR_NOW="${1//[^A-Za-z0-9 ._:\/()-]/_}"; ERR_NOW="${ERR_NOW:0:100}"; }

# ---------------------------------------------------------------------------------------------------
# État persistant (clé=valeur, clés et valeurs strictement filtrées)
# ---------------------------------------------------------------------------------------------------
load_state() {
  local k v
  [[ -r $STATE ]] || return 0
  while IFS='=' read -r k v || [[ -n $k ]]; do
    [[ $k =~ ^[a-z_]{1,24}$ && $v =~ ^[A-Za-z0-9._/:\ ()-]{0,120}$ ]] && S[$k]=$v
  done <"$STATE"
}

save_state() {
  local k
  {
    for k in "${!S[@]}"; do printf '%s=%s\n' "$k" "${S[$k]}"; done
  } >"$STATE"
}

# ---------------------------------------------------------------------------------------------------
# Configuration (jamais « sourcée » : lecture clé par clé, valeurs validées)
# ---------------------------------------------------------------------------------------------------
load_config() {
  local k v
  [[ -r $CONFIG ]] || { note_error "config introuvable"; return 1; }
  while IFS='=' read -r k v || [[ -n $k ]]; do
    [[ -z $k || $k == \#* ]] && continue
    v="${v%\"}"; v="${v#\"}"
    case $k in
      IK_API_URL) IK_API_URL=$v ;;
      IK_API_KEY) IK_API_KEY=$v ;;
      IK_TOKEN) IK_TOKEN=$v ;;
      IK_LOG_PATH) IK_LOG_PATH=$v ;;
      IK_SITES_DIR) IK_SITES_DIR=$v ;;
    esac
  done <"$CONFIG"
  IK_API_URL="${IK_API_URL%/}"
  if [[ ! $IK_API_URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then note_error "IK_API_URL invalide (HTTPS obligatoire)"; return 1; fi
  if [[ ! $IK_API_KEY =~ ^[A-Za-z0-9._-]{10,300}$ ]]; then note_error "IK_API_KEY invalide"; return 1; fi
  if [[ ! $IK_TOKEN =~ ^ikh_[0-9a-f]{12}_[0-9a-f]{64}$ ]]; then note_error "IK_TOKEN invalide"; return 1; fi
  IK_LOG_PATH="${IK_LOG_PATH:-$BASE/ik-logs/access.log}"
  IK_LOG_PATH="${IK_LOG_PATH/#\~/$BASE}"
  IK_SITES_DIR="${IK_SITES_DIR:-$BASE/sites}"
  IK_SITES_DIR="${IK_SITES_DIR/#\~/$BASE}"
  return 0
}

# ---------------------------------------------------------------------------------------------------
# Verrou : pas de chevauchement (aucun fork). Un verrou orphelin (processus mort ou PID réutilisé) est ignoré.
# ---------------------------------------------------------------------------------------------------
acquire_lock() {
  local pid cmd
  if [[ -s $LOCK ]]; then
    read -r pid <"$LOCK"
    if [[ $pid =~ ^[0-9]+$ && -r $PROC/$pid/cmdline ]]; then
      cmd=""
      mapfile -d '' -t cmd <"$PROC/$pid/cmdline"
      [[ "${cmd[*]}" == *ik-agent* ]] && return 1
    fi
  fi
  printf '%s\n' "$$" >"$LOCK"
  return 0
}
# shellcheck disable=SC2317  # appelée via trap
release_lock() { : >"$LOCK"; }

# ---------------------------------------------------------------------------------------------------
# Collecte
# ---------------------------------------------------------------------------------------------------
CPU_PCT="null"
# CPU % = 100 × (1 − Δ(idle+iowait) / Δtotal) entre deux relevés cumulatifs de /proc/stat.
collect_cpu() {
  local now=$1 _ v user nice system idle iowait irq softirq steal total idle_all dt di el p10
  CPU_PCT="null"
  [[ -r $PROC/stat ]] || return 1
  read -r _ user nice system idle iowait irq softirq steal _ <"$PROC/stat" || return 1
  for v in "$user" "$nice" "$system" "$idle" "$iowait" "$irq" "$softirq" "${steal:-0}"; do
    [[ $v =~ ^[0-9]+$ ]] || return 1
  done
  total=$((user + nice + system + idle + iowait + irq + softirq + ${steal:-0}))
  idle_all=$((idle + iowait))
  if [[ ${S[prev_total]:-} =~ ^[0-9]+$ && ${S[prev_idle]:-} =~ ^[0-9]+$ && ${S[prev_ts]:-} =~ ^[0-9]+$ ]]; then
    local p_total=${S[prev_total]} p_idle=${S[prev_idle]} p_ts=${S[prev_ts]}
    dt=$((total - p_total)); di=$((idle_all - p_idle)); el=$((now - p_ts))
    # Premier relevé, redémarrage (compteurs qui reculent) ou trop long silence : pas de valeur inventée.
    if ((dt > 0 && di >= 0 && di <= dt && el > 0 && el <= MAX_CPU_GAP_S)); then
      p10=$(((1000 * (dt - di) + dt / 2) / dt))
      printf -v CPU_PCT '%d.%d' $((p10 / 10)) $((p10 % 10))
    fi
  fi
  S[prev_total]=$total; S[prev_idle]=$idle_all; S[prev_ts]=$now
  return 0
}

MEM_TOTAL=0 MEM_USED=0 MEM_AVAIL=0 SWAP_TOTAL=0 SWAP_USED=0
collect_mem() {
  local key val _u mt=0 ma=0 st=0 sf=0
  [[ -r $PROC/meminfo ]] || return 1
  while read -r key val _u; do
    case $key in
      MemTotal:) mt=$val ;; MemAvailable:) ma=$val ;; SwapTotal:) st=$val ;; SwapFree:) sf=$val ;;
    esac
  done <"$PROC/meminfo"
  [[ $mt =~ ^[0-9]+$ && $ma =~ ^[0-9]+$ && $st =~ ^[0-9]+$ && $sf =~ ^[0-9]+$ ]] || return 1
  ((mt > 0 && ma <= mt && sf <= st)) || return 1
  MEM_TOTAL=$((mt / 1024)); MEM_AVAIL=$((ma / 1024)); MEM_USED=$(((mt - ma) / 1024))
  SWAP_TOTAL=$((st / 1024)); SWAP_USED=$(((st - sf) / 1024))
}

# Données lentes (disque, cœurs, log) : rafraîchies toutes les 5 minutes, réutilisées entre-temps.
refresh_slow() {
  local now=$1 last line cores=0 dev blocks used avail sz ino
  if [[ ${S[slow_ts]:-} =~ ^[0-9]+$ && -n ${S[disk_total]:-} ]]; then
    last=${S[slow_ts]}
    ((now - last < SLOW_REFRESH_S && now >= last)) && return 0
  fi
  while IFS= read -r line; do [[ $line == processor* ]] && ((cores++)); done <"$PROC/cpuinfo" 2>/dev/null
  ((cores > 0)) && S[cores]=$cores

  local -a df_cmd=(df -Pk --)
  command -v timeout >/dev/null 2>&1 && df_cmd=(timeout 5 "${df_cmd[@]}")
  { read -r _; read -r dev blocks used avail _; } < <("${df_cmd[@]}" "$BASE" 2>/dev/null)
  if [[ $blocks =~ ^[0-9]+$ && $used =~ ^[0-9]+$ && $avail =~ ^[0-9]+$ ]] && ((blocks > 0)); then
    [[ $dev =~ ^[A-Za-z0-9._/:-]{1,100}$ ]] || dev="unknown"
    S[disk_dev]=$dev; S[disk_total]=$((blocks / 1024)); S[disk_used]=$((used / 1024)); S[disk_avail]=$((avail / 1024))
  fi

  if [[ -r $IK_LOG_PATH ]]; then
    read -r sz ino < <(stat -c '%s %i' -- "$IK_LOG_PATH" 2>/dev/null)
    [[ $sz =~ ^[0-9]+$ && $ino =~ ^[0-9]+$ ]] && { S[log_size]=$sz; S[log_inode]=$ino; }
  fi
  S[slow_ts]=$now
}

# Construit le JSON d'un relevé dans POINT. Retourne 1 si une valeur est inutilisable.
POINT=""
build_point() {
  local now=$1 l1 l5 l15 _ v up cores
  [[ -r $PROC/loadavg && -r $PROC/uptime ]] || return 1
  read -r l1 l5 l15 _ <"$PROC/loadavg" || return 1
  for v in "$l1" "$l5" "$l15"; do [[ $v =~ ^[0-9]+(\.[0-9]+)?$ ]] || return 1; done
  read -r up _ <"$PROC/uptime" || return 1
  up=${up%.*}; [[ $up =~ ^[0-9]+$ ]] || return 1
  cores=${S[cores]:-0}; ((cores > 0)) || return 1
  [[ -n ${S[disk_total]:-} ]] || return 1
  collect_mem || return 1
  collect_cpu "$now" || CPU_PCT="null"
  printf -v POINT '{"ts":%d,"cpu_cores":%d,"load":[%s,%s,%s],"cpu_pct":%s,"mem":{"total_mb":%d,"used_mb":%d,"avail_mb":%d},"swap":{"total_mb":%d,"used_mb":%d},"disk":{"device":"%s","total_mb":%d,"used_mb":%d,"avail_mb":%d},"uptime_s":%d}' \
    "$now" "$cores" "$l1" "$l5" "$l15" "$CPU_PCT" "$MEM_TOTAL" "$MEM_USED" "$MEM_AVAIL" "$SWAP_TOTAL" "$SWAP_USED" \
    "${S[disk_dev]:-unknown}" "${S[disk_total]}" "${S[disk_used]}" "${S[disk_avail]}" "$up"
}

# ---------------------------------------------------------------------------------------------------
# Sites de l'hébergement : noms des dossiers de ~/sites qui ressemblent à un nom de domaine.
# Lecture par « glob » Bash : aucun processus lancé, aucun fichier ouvert.
# ---------------------------------------------------------------------------------------------------
DOMAINS_JSON="" DOMAINS_N=0
collect_domains() {
  local p name lower re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$'
  DOMAINS_JSON=""; DOMAINS_N=0
  shopt -s nullglob
  for p in "$IK_SITES_DIR"/*/; do
    name=${p%/}; name=${name##*/}; lower=${name,,}
    if ((${#lower} > 253)) || [[ ! $lower =~ $re ]]; then continue; fi
    ((DOMAINS_N >= MAX_DOMAINS)) && break
    DOMAINS_JSON+="${DOMAINS_JSON:+,}\"$lower\""
    ((DOMAINS_N++))
  done
  shopt -u nullglob
}

# ---------------------------------------------------------------------------------------------------
# Spool : relevés en attente d'envoi (30 max, les plus anciens sont abandonnés)
# ---------------------------------------------------------------------------------------------------
load_spool() {
  local line
  spool=()
  [[ -r $SPOOL ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == '{"ts":'*'}' && ${#line} -lt 1500 ]] && spool+=("$line")
  done <"$SPOOL"
}
JOINED=""
join_spool() { local IFS=,; JOINED="${spool[*]:-}"; }
save_spool() {
  if ((${#spool[@]} == 0)); then : >"$SPOOL"; else printf '%s\n' "${spool[@]}" >"$SPOOL"; fi
}

main() {
  local now body points last_error backlog hostname="${HOSTNAME:-unknown}" code resp err api_msg send_domains=0 dom_last

  printf -v now '%(%s)T' -1
  [[ ${IK_NOW:-} =~ ^[0-9]+$ ]] && now=$IK_NOW

  [[ -d $DIR ]] || mkdir -p "$DIR" || { echo "ik-agent: impossible de créer $DIR" >&2; return 0; }
  acquire_lock || return 0
  trap release_lock EXIT

  load_state
  load_spool

  if ! load_config; then
    err=$ERR_NOW
    if [[ $err != "${S[last_error]:-}" ]]; then log "ERREUR: $err"; S[last_error]=$err; ((DRYRUN)) || save_state; fi
    return 0
  fi

  # --- Collecte (uniquement si le serveur nous a désigné collecteur système) --------------------------
  if [[ ${S[collector]:-0} == 1 ]]; then
    refresh_slow "$now"
    if build_point "$now"; then
      ((DRYRUN)) || spool+=("$POINT")
      ((${#spool[@]} > MAX_SPOOL)) && spool=("${spool[@]: -MAX_SPOOL}")
    else
      log "AVERTISSEMENT: relevé système inutilisable (lecture de $PROC)"
    fi
  fi

  # --- Corps de la requête ------------------------------------------------------------------------------
  [[ $hostname =~ ^[A-Za-z0-9._-]{1,255}$ ]] || hostname="unknown"
  backlog=${#spool[@]}
  if [[ ${S[collector]:-0} != 1 ]]; then refresh_log_only "$now"; fi
  last_error="null"; [[ -n ${S[last_error]:-} ]] && last_error="\"${S[last_error]}\""
  if ((DRYRUN)) && [[ ${S[collector]:-0} == 1 && -n $POINT ]]; then points=$POINT; else join_spool; points=$JOINED; fi
  # Liste des sites : à l'installation, quand elle change, puis toutes les 6 h ; jamais avec un gros spool (taille du message).
  send_domains=0
  if [[ -d $IK_SITES_DIR ]]; then
    collect_domains
    if ((DOMAINS_N > 0 && ${#spool[@]} <= 5)); then
      dom_last=${S[dom_ts]:-0}; [[ $dom_last =~ ^[0-9]+$ ]] || dom_last=0
      if [[ ${S[dom_n]:-} != "$DOMAINS_N" ]] || ((now - dom_last >= DOMAINS_EVERY_S || now < dom_last)); then send_domains=1; fi
    fi
  fi
  printf -v body '{"v":1,"agent_version":"%s","hostname":"%s","agent":{"backlog":%d,"last_error":%s,"log":{"size":%d,"inode":%d}},"points":[%s]}' \
    "$AGENT_VERSION" "$hostname" "$backlog" "$last_error" "${S[log_size]:-0}" "${S[log_inode]:-0}" "$points"

  if ((send_domains)); then body="${body%\}},\"domains\":[$DOMAINS_JSON]}"; fi

  if ((DRYRUN)); then
    printf '%s\n' "$body"
    save_state
    return 0
  fi

  # --- Envoi : le token ne passe jamais dans la ligne de commande (visible via ps) mais dans un fichier 600.
  { printf 'x-agent-token: %s\n' "$IK_TOKEN"; printf 'apikey: %s\n' "$IK_API_KEY"; } >"$HDR"
  code=$(curl -sS -o "$RESP" -w '%{http_code}' --connect-timeout 5 --max-time 10 --retry 0 \
    -X POST -H "@$HDR" -H 'Content-Type: application/json' \
    --data-binary "$body" "$IK_API_URL/rest/v1/rpc/agent_heartbeat" 2>"$CURL_ERR")
  code=${code:-000}
  resp=""; [[ -r $RESP ]] && resp=$(<"$RESP")
  # Message d'erreur de l'API (PostgREST) : rendu visible dans le journal pour faciliter le diagnostic.
  api_msg=""
  if [[ $code != 200 && $resp =~ \"message\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then api_msg=${BASH_REMATCH[1]}; fi

  case $code in
    200)
      if [[ $resp =~ \"collector\"[[:space:]]*:[[:space:]]*true ]]; then S[collector]=1; else S[collector]=0; fi
      spool=()
      if ((send_domains)); then S[dom_ts]=$now; S[dom_n]=$DOMAINS_N; fi
      # Actions : liste blanche, non implémentée dans cette version (analyse de logs en phase 7).
      if [[ $resp =~ \"type\"[[:space:]]*:[[:space:]]*\" ]]; then note_error "action recue non supportee par cette version de l agent ($AGENT_VERSION)"; else ERR_NOW=""; fi
      ;;
    401|403) note_error "authentification refusee (HTTP $code) : token revoque ou invalide" ;;
    429) ERR_NOW="${S[last_error]:-}" ;;
    000)
      read -r err <"$CURL_ERR" 2>/dev/null
      note_error "reseau : ${err:-echec de connexion}"
      ;;
    *) note_error "HTTP $code${api_msg:+ - $api_msg}" ;;
  esac

  if [[ $ERR_NOW != "${S[last_error]:-}" ]]; then
    if [[ -n $ERR_NOW ]]; then log "ERREUR: $ERR_NOW"; else log "OK: envois rétablis (HTTP $code)"; fi
  fi
  S[last_error]=$ERR_NOW
  ((VERBOSE)) && log "heartbeat HTTP $code collector=${S[collector]:-0} spool=${#spool[@]}"

  save_spool
  save_state
  return 0
}

# Agent non collecteur : seule la taille du log est utile (toutes les 5 minutes, 1 fork).
refresh_log_only() {
  local now=$1 last sz ino
  if [[ ${S[log_ts]:-} =~ ^[0-9]+$ ]]; then
    last=${S[log_ts]}
    ((now - last < SLOW_REFRESH_S && now >= last)) && return 0
  fi
  if [[ -r $IK_LOG_PATH ]]; then
    read -r sz ino < <(stat -c '%s %i' -- "$IK_LOG_PATH" 2>/dev/null)
    [[ $sz =~ ^[0-9]+$ && $ino =~ ^[0-9]+$ ]] && { S[log_size]=$sz; S[log_inode]=$ino; }
  fi
  S[log_ts]=$now
}

while (($#)); do
  case $1 in
    -v | --verbose) VERBOSE=1 ;;
    -n | --dry-run) DRYRUN=1; VERBOSE=1 ;;
    --version) echo "ik-agent $AGENT_VERSION"; exit 0 ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done

main
exit 0
