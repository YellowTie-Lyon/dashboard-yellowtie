#!/usr/bin/env bash
# YellowScope – installateur de l'agent (aucun droit root requis).
#
#   curl -fsSL https://<site>/agent/install.sh -o ik-install.sh
#   bash ik-install.sh --base-url https://<site> --api-url https://<projet>.supabase.co --api-key <clé publique>
#
# Le token de l'hébergement est demandé en saisie masquée : il n'apparaît ni dans la ligne de commande ni
# dans l'historique du shell. Réexécutable sans risque (idempotent). Désinstallation : --uninstall.
set -euo pipefail
umask 077

BASE_URL="" API_URL="" API_KEY="" TOKEN="${IK_TOKEN:-}" UNINSTALL=0 RUN_NOW=1
HOME_DIR="${IK_HOME:-${HOME:-}}"
DIR="$HOME_DIR/.ik-monitor"
CRON_MARK="ik-monitor/ik-agent.sh"

die() { echo "ERREUR : $*" >&2; exit 1; }
info() { echo "-> $*"; }

usage() {
  cat <<USAGE
Usage : bash install.sh --base-url URL --api-url URL --api-key CLE [--no-run]
        bash install.sh --uninstall
USAGE
}

while (($#)); do
  case $1 in
    --base-url) BASE_URL=${2:-}; shift ;;
    --api-url) API_URL=${2:-}; shift ;;
    --api-key) API_KEY=${2:-}; shift ;;
    --token) TOKEN=${2:-}; shift ;;
    --no-run) RUN_NOW=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "option inconnue : $1" ;;
  esac
  shift
done

[[ -n $HOME_DIR && $HOME_DIR != *[[:space:]]* ]] || die "dossier personnel introuvable ou contenant des espaces"
command -v crontab >/dev/null 2>&1 || die "crontab est introuvable sur ce serveur"

# Retire uniquement notre ligne de la crontab (les autres tâches sont conservées).
remove_cron_line() {
  local current
  current=$(crontab -l 2>/dev/null || true)
  if [[ $current == *"$CRON_MARK"* ]]; then
    printf '%s\n' "$current" | grep -v "$CRON_MARK" | crontab - || true
  fi
}

if ((UNINSTALL)); then
  remove_cron_line
  rm -rf "$DIR"
  info "Agent désinstallé (tâche cron retirée, $DIR supprimé)."
  exit 0
fi

# --- Validation des paramètres ---------------------------------------------------------------------------
if [[ ! $BASE_URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  [[ ${IK_INSTALL_ALLOW_FILE:-} == 1 && $BASE_URL == file://* ]] || die "--base-url doit être une URL HTTPS (ex. https://yellowscope.netlify.app)"
fi
[[ $API_URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "--api-url doit être une URL HTTPS (ex. https://xxxx.supabase.co)"
[[ $API_KEY =~ ^[A-Za-z0-9._-]{10,300}$ ]] || die "--api-key invalide (clé publique du projet)"

mkdir -p "$DIR"

# --- Token (saisie masquée ; Entrée conserve celui d'une installation précédente) --------------------------
existing_token=""
if [[ -r $DIR/config ]]; then
  existing_token=$(sed -n 's/^IK_TOKEN=//p' "$DIR/config" | head -1)
fi
if [[ -z $TOKEN ]]; then
  [[ -r /dev/tty ]] || die "aucun terminal : fournissez le token via la variable d'environnement IK_TOKEN"
  prompt="Token de cet hébergement (saisie masquée)"
  [[ -n $existing_token ]] && prompt="$prompt, Entrée pour conserver l'actuel"
  read -rsp "$prompt : " TOKEN </dev/tty
  echo
  [[ -n $TOKEN ]] || TOKEN=$existing_token
fi
[[ $TOKEN =~ ^ikh_[0-9a-f]{12}_[0-9a-f]{64}$ ]] || die "token invalide (format attendu : ikh_ + 12 + _ + 64 caractères hexadécimaux)"

# --- Téléchargement et vérification de l'agent ------------------------------------------------------------
tmp=$(mktemp -d "$DIR/dl.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
fetch() { curl -fsSL --connect-timeout 10 --max-time 60 -o "$2" "$1" || die "téléchargement impossible : $1"; }

info "Téléchargement de l'agent depuis $BASE_URL"
fetch "$BASE_URL/agent/ik-agent.sh" "$tmp/ik-agent.sh"
fetch "$BASE_URL/agent/SHA256SUMS" "$tmp/SHA256SUMS"
expected=$(awk '$2 == "ik-agent.sh" { print $1 }' "$tmp/SHA256SUMS")
actual=$(sha256sum "$tmp/ik-agent.sh" | awk '{ print $1 }')
[[ -n $expected && $expected == "$actual" ]] || die "somme de contrôle incorrecte : fichier corrompu ou modifié, installation annulée"
bash -n "$tmp/ik-agent.sh" || die "l'agent téléchargé contient une erreur de syntaxe"

mv -f "$tmp/ik-agent.sh" "$DIR/ik-agent.sh"
chmod 700 "$DIR/ik-agent.sh"

# --- Configuration (lecture seule pour vous) --------------------------------------------------------------
{
  printf 'IK_API_URL=%s\n' "$API_URL"
  printf 'IK_API_KEY=%s\n' "$API_KEY"
  printf 'IK_TOKEN=%s\n' "$TOKEN"
} >"$DIR/config"
chmod 600 "$DIR/config"

# --- Cron : une ligne, idempotente, avec sauvegarde de la crontab existante -------------------------------
current=$(crontab -l 2>/dev/null || true)
printf '%s\n' "$current" >"$DIR/crontab.bak"
# Priorité NORMALE pour l'envoi (quelques millisecondes de CPU) : sur un serveur saturé, une priorité basse empêcherait l'agent d'envoyer au moment où
# l'information est la plus utile. Seule l'analyse des logs, la partie qui coûte un peu, tourne en priorité basse (voir ik-agent.sh).
line="* * * * * $DIR/ik-agent.sh >/dev/null 2>&1"
if [[ -n $current ]]; then
  { printf '%s\n' "$current" | grep -v "$CRON_MARK" || true; printf '%s\n' "$line"; } | crontab -
else
  printf '%s\n' "$line" | crontab -
fi
info "Tâche cron installée (toutes les minutes). Ancienne crontab sauvegardée dans $DIR/crontab.bak"

if ((RUN_NOW)); then
  info "Premier envoi de test :"
  "$DIR/ik-agent.sh" --verbose || true
fi

cat <<DONE

Installation terminée. Dans une à deux minutes, cet hébergement apparaît dans YellowScope
(page de l'hébergement > « État de l'agent »).
Journal de l'agent : $DIR/agent.log     Désinstaller : bash ik-install.sh --uninstall
DONE
