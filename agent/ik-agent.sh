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
#   * analyse l'access.log chaque minute (lecture des seuls octets nouveaux, 2 processus, agrégats uniquement).
#
# Usage : ik-agent.sh [--verbose] [--dry-run] | --version | --help
set -u

readonly AGENT_VERSION="0.4.0"
readonly MAX_SPOOL=30
readonly SLOW_REFRESH_S=300     # df / stat / cœurs : toutes les 5 minutes
readonly MAX_CPU_GAP_S=300      # au-delà, l'écart entre deux relevés rend le CPU % trompeur
readonly MAX_DOMAINS=200        # sites remontés au plus (dossiers de ~/sites)
readonly DOMAINS_EVERY_S=21600  # liste des sites renvoyée au moins toutes les 6 heures (ou dès qu'elle change)
readonly TRAFFIC_EVERY_S=55     # analyse de l'access.log : à chaque passage du cron (~1 minute), comme le load
readonly TRAFFIC_MAX_BYTES=4194304   # au plus 4 Mo de log lus par analyse (les plus récents) ; 1 Mo si le serveur est chargé
readonly MAX_TRAFFIC_PENDING=3  # fenêtres d'analyse conservées en attente d'envoi

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
TRAFFIC="$DIR/traffic"

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

# ---------------------------------------------------------------------------------------------------
# Trafic : analyse de l'access.log (format « vhost ip - - [date] "MÉTHODE /chemin HTTP/x" code octets "ref" "ua" »).
# Chaque minute : on ne lit que les octets ajoutés depuis la dernière analyse (décalage mémorisé), plafonnés à
# TRAFFIC_MAX_BYTES ; un seul awk agrège (domaines, URL, IP, types de visiteurs, codes) et n'émet qu'un résumé JSON.
# Aucune ligne de log ne quitte l'hébergement. Coût : 3 processus courts (subshell, tail, awk) par minute, sur quelques Ko en temps normal.
# ---------------------------------------------------------------------------------------------------
read -r -d '' AWK_TRAFFIC <<'EOF' || true
function pick(arr,   k, best, bk) { best = -1; bk = ""; for (k in arr) if (arr[k] > best) { best = arr[k]; bk = k } return bk }
# Signature d'une query string : NOMS des paramètres (jamais les valeurs), triés, 6 au plus (« filter_couleur,min_price,orderby »).
function qsig(qs,   n, parts, i, nm, e, cnt, names, j, out, seen, tot) {
  n = split(qs, parts, "&"); cnt = 0; tot = 0
  for (i = 1; i <= n && i <= 12; i++) {
    nm = parts[i]; e = index(nm, "="); if (e > 0) nm = substr(nm, 1, e - 1)
    gsub(/[^A-Za-z0-9_.-]/, "", nm)
    if (nm == "") continue
    if (length(nm) > 24) nm = substr(nm, 1, 24)
    if (nm in seen) continue
    seen[nm] = 1; tot++
    if (cnt < 6) { cnt++; names[cnt] = nm }
  }
  for (i = 2; i <= cnt; i++) { nm = names[i]; j = i - 1; while (j >= 1 && names[j] > nm) { names[j + 1] = names[j]; j-- } names[j + 1] = nm }
  out = ""
  for (i = 1; i <= cnt; i++) out = out (i > 1 ? "," : "") names[i]
  if (tot > cnt) out = out ",+"
  return out
}
BEGIN { FS = "\""; cb = 0; RE_BAD = "[^A-Za-z0-9._~:/?@!$&()*+,;=%-]"; RE_UA = "[^A-Za-z0-9 ._/;:()+,-]" }
{
  len = length($0) + 1
  if (cb + len > LIMIT) exit
  cb += len
  if (NR == 1 && SKIP1 == 1) next
  lines++
  if (NF < 6) { bad++; next }
  n = split($1, a, " ")
  if (n < 2) { bad++; next }
  split($2, r, " "); split($3, st, " ")
  code = st[1]
  if (code !~ /^[0-9][0-9][0-9]$/) { bad++; next }
  vh = tolower(a[1])
  if (substr(vh, 1, 1) == "[") { sub(/^\[/, "", vh); sub(/\].*$/, "", vh) }
  sub(/:[0-9]+$/, "", vh); sub(/^www\./, "", vh)
  if (vh !~ /^[a-z0-9.-]+$/ || length(vh) > 100) vh = "(autre)"
  ip = a[2]
  if (ip !~ /^[0-9a-fA-F:.]+$/ || length(ip) > 45) ip = "?"
  path = r[2]
  sig = ""
  q = index(path, "?")
  if (q > 0) { sig = qsig(substr(path, q + 1)); path = substr(path, 1, q - 1) }
  if (path == "") path = "/"
  gsub(RE_BAD, "_", path)
  if (length(path) > 100) path = substr(path, 1, 100)
  nb = st[2] + 0
  c = substr(code, 1, 1)
  ua = tolower($6)
  bot = 0
  if (ua ~ /googlebot/) { ug++; bot = 1 }
  else if (ua ~ /bot|crawl|spider|slurp|facebookexternalhit|semrush|ahrefs|bytespider|petalbot|headless|python|curl|wget|scrapy|go-http|libwww|okhttp/) { ub++; bot = 1 }
  else if (ua == "" || ua == "-") ue++
  else uh++
  uk = $6; gsub(RE_UA, "_", uk)
  if (uk == "" || uk == "-") uk = "(vide)"
  if (length(uk) > 70) uk = substr(uk, 1, 70)

  if (!(vh in dn) && nd >= 300) vh = "(autre)"
  if (!(vh in dn)) { nd++; dn[vh] = 0; db[vh] = 0 }
  dn[vh]++; db[vh] += nb; dbt[vh] += bot
  if (c == "2") d2[vh]++; else if (c == "3") d3[vh]++; else if (c == "4") d4[vh]++; else if (c == "5") d5[vh]++
  if (code == "404") d404[vh]++; else if (code == "401" || code == "403") d403[vh]++
  post = (r[1] == "POST")
  if (post) { dm[vh]++; tm++ }
  tot++; tb += nb
  if (c == "2") t2++; else if (c == "3") t3++; else if (c == "4") t4++; else if (c == "5") t5++

  pk = vh "\t" path (sig != "" ? "?" sig : "")
  if (pk in pn || np < 20000) {
    if (!(pk in pn)) { np++; dpc[vh]++ }
    pn[pk]++; if (c == "4" || c == "5") pe[pk]++; if (post) pm[pk]++
  }
  if (sig != "") { qk = vh "\t" sig; if (qk in qn || nq < 5000) { if (!(qk in qn)) nq++; qn[qk]++; if (c == "4" || c == "5") qe[qk]++ } }
  if (ip in ipn || ni < 20000) { if (!(ip in ipn)) ni++; ipn[ip]++ }
  xk = ip "|" vh
  if (xk in xn || nx < 20000) { if (!(xk in xn)) nx++; xn[xk]++ }
  if (uk in uan || nua < 2000) { if (!(uk in uan)) nua++; uan[uk]++ }
}
END {
  out = sprintf("{\"ts\":%d,\"win\":%d,\"cb\":%d,\"lines\":%d,\"bad\":%d,\"trunc\":%d,\"n\":%d,\"b\":%.0f,\"s\":[%d,%d,%d,%d],\"m\":%d,\"ua\":{\"g\":%d,\"b\":%d,\"h\":%d,\"e\":%d},\"d\":[",
    TS, WIN, cb, lines, bad, TRUNC, tot, tb, t2, t3, t4, t5, tm, ug, ub, uh, ue)
  sep = ""; dmo = ""; dsep = ""
  for (i = 0; i < 30; i++) {
    k = pick(dn); if (k == "") break
    out = out sprintf("%s{\"h\":\"%s\",\"n\":%d,\"b\":%.0f,\"s\":[%d,%d,%d,%d],\"m\":%d,\"bt\":%d}", sep, k, dn[k], db[k], d2[k], d3[k], d4[k], d5[k], dm[k], dbt[k])
    if (i < 10) { dmo = dmo sprintf("%s{\"h\":\"%s\",\"pc\":%d,\"n4\":%d,\"n3\":%d}", dsep, k, dpc[k], d404[k], d403[k]); dsep = "," }
    sep = ","; delete dn[k]
  }
  out = out "],\"u\":["; sep = ""
  for (i = 0; i < 15; i++) {
    k = pick(pn); if (k == "") break
    split(k, kk, "\t")
    out = out sprintf("%s{\"h\":\"%s\",\"p\":\"%s\",\"n\":%d,\"e\":%d,\"m\":%d}", sep, kk[1], kk[2], pn[k], pe[k], pm[k])
    sep = ","; delete pn[k]
  }
  out = out "],\"q\":["; sep = ""
  for (i = 0; i < 12; i++) {
    k = pick(qn); if (k == "") break
    split(k, kk, "\t")
    out = out sprintf("%s{\"h\":\"%s\",\"q\":\"%s\",\"n\":%d,\"e\":%d}", sep, kk[1], kk[2], qn[k], qe[k])
    sep = ","; delete qn[k]
  }
  out = out "],\"a\":["; sep = ""
  for (i = 0; i < 10; i++) {
    k = pick(uan); if (k == "") break
    out = out sprintf("%s{\"ua\":\"%s\",\"n\":%d}", sep, k, uan[k])
    sep = ","; delete uan[k]
  }
  out = out "],\"x\":["; sep = ""
  for (i = 0; i < 10; i++) {
    k = pick(xn); if (k == "") break
    split(k, kk, "|")
    out = out sprintf("%s{\"ip\":\"%s\",\"h\":\"%s\",\"n\":%d}", sep, kk[1], kk[2], xn[k])
    sep = ","; delete xn[k]
  }
  out = out "],\"dm\":[" dmo "],\"i\":["; sep = ""
  for (i = 0; i < 10; i++) {
    k = pick(ipn); if (k == "") break
    out = out sprintf("%s{\"ip\":\"%s\",\"n\":%d}", sep, k, ipn[k])
    sep = ","; delete ipn[k]
  }
  print out "]}"
}
EOF

TRAFFIC_JSON=""
# Charge les fenêtres en attente (une ligne JSON par fenêtre, 3 au plus) dans TRAFFIC_JSON.
load_traffic() {
  local line n=0
  TRAFFIC_JSON=""
  [[ -r $TRAFFIC ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == '{"ts":'*'}' && ${#line} -lt 16000 ]] || continue
    TRAFFIC_JSON+="${TRAFFIC_JSON:+,}$line"; ((n++))
  done <"$TRAFFIC"
  ((n > 0))
}

collect_traffic() {
  local now=$1 sz ino off cap limit skip=0 trunc=0 out cb newoff l1 _ cores=0 line last=0
  [[ -r $IK_LOG_PATH ]] || return 0
  if [[ ${S[tr_ts]:-} =~ ^[0-9]+$ ]]; then last=${S[tr_ts]}; fi
  ((now - last < TRAFFIC_EVERY_S && now >= last)) && return 0
  command -v awk >/dev/null 2>&1 || { note_error "awk absent : analyse du trafic impossible"; return 0; }
  read -r sz ino < <(stat -c '%s %i' -- "$IK_LOG_PATH" 2>/dev/null)
  [[ $sz =~ ^[0-9]+$ && $ino =~ ^[0-9]+$ ]] || return 0
  S[tr_ts]=$now

  # Première analyse : on part de la fin du fichier (aucun historique relu).
  if [[ ! ${S[tr_off]:-} =~ ^[0-9]+$ || ! ${S[tr_ino]:-} =~ ^[0-9]+$ ]]; then S[tr_ino]=$ino; S[tr_off]=$sz; return 0; fi
  off=${S[tr_off]}
  if [[ ${S[tr_ino]} != "$ino" ]] || ((off > sz)); then off=0; fi   # rotation ou troncature : on relit le nouveau fichier
  ((sz > off)) || { S[tr_ino]=$ino; S[tr_off]=$off; return 0; }

  # Garde-fou de charge : serveur déjà très chargé (load 1 min > 2 × cœurs) => lecture 4 fois plus courte.
  cap=$TRAFFIC_MAX_BYTES
  if read -r l1 _ <"$PROC/loadavg" 2>/dev/null && [[ $l1 =~ ^[0-9]+ ]]; then
    while IFS= read -r line; do [[ $line == processor* ]] && ((cores++)); done <"$PROC/cpuinfo" 2>/dev/null
    ((cores > 0 && ${l1%.*} > 2 * cores)) && cap=$((cap / 4))
  fi
  if ((sz - off > cap)); then off=$((sz - cap)); skip=1; trunc=1; fi
  limit=$((sz - off))

  out=$(tail -c "+$((off + 1))" -- "$IK_LOG_PATH" 2>/dev/null | awk -v LIMIT="$limit" -v SKIP1="$skip" -v TS="$now" -v WIN="$TRAFFIC_EVERY_S" -v TRUNC="$trunc" "$AWK_TRAFFIC" 2>/dev/null)
  if [[ $out != '{"ts":'*'}' || ${#out} -gt 15000 ]]; then note_error "analyse du trafic invalide"; return 0; fi
  cb=0; [[ $out =~ \"cb\":([0-9]+) ]] && cb=${BASH_REMATCH[1]}
  newoff=$((off + cb))
  # Une ligne plus longue que la fenêtre de lecture ne doit pas bloquer l'analyse : on saute à la fin.
  if ((cb == 0 && limit >= cap)); then newoff=$sz; fi
  S[tr_ino]=$ino; S[tr_off]=$newoff
  [[ $out == *'"lines":0,'* ]] && return 0
  ((DRYRUN)) && return 0

  local -a pending=()
  if [[ -r $TRAFFIC ]]; then
    while IFS= read -r line || [[ -n $line ]]; do [[ $line == '{"ts":'*'}' ]] && pending+=("$line"); done <"$TRAFFIC"
  fi
  pending+=("$out")
  ((${#pending[@]} > MAX_TRAFFIC_PENDING)) && pending=("${pending[@]: -MAX_TRAFFIC_PENDING}")
  printf '%s\n' "${pending[@]}" >"$TRAFFIC"
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

  # --- Trafic (chaque minute) : la fenêtre calculée est mise en attente puis envoyée avec le heartbeat -----
  collect_traffic "$now"
  load_traffic

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
  if [[ -n $TRAFFIC_JSON ]]; then body="${body%\}},\"traffic\":[$TRAFFIC_JSON]}"; fi

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
      [[ -n $TRAFFIC_JSON ]] && : >"$TRAFFIC"
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
