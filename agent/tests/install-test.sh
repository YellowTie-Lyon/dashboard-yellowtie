#!/usr/bin/env bash
# Tests de l'installeur : téléchargement local (file://), faux crontab, aucun accès réseau.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
TOKEN="ikh_0123456789ab_$(printf 'a%.0s' {1..64})"
PASS=0; FAIL=0
check() { local d=$1; shift; if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "  ÉCHEC : $d"; fi; }
eq() { [[ "$1" == "$2" ]] || { echo "    attendu : [$2]  obtenu : [$1]"; return 1; }; }
has() { [[ "$1" == *"$2"* ]] || { echo "    [$2] introuvable dans : ${1:0:300}"; return 1; }; }
hasnt() { [[ "$1" != *"$2"* ]] || { echo "    [$2] ne devrait pas apparaître"; return 1; }; }

new_env() {
  T="$(mktemp -d)"
  export IK_HOME="$T/home" MOCK_CRON="$T/crontab" IK_INSTALL_ALLOW_FILE=1 IK_TOKEN="$TOKEN"
  mkdir -p "$IK_HOME" "$T/site/agent" "$T/bin"
  cp "$ROOT/ik-agent.sh" "$T/site/agent/"
  (cd "$T/site/agent" && sha256sum ik-agent.sh >SHA256SUMS)
  cat >"$T/bin/crontab" <<'CRON'
#!/usr/bin/env bash
if [[ ${1:-} == "-l" ]]; then [[ -f $MOCK_CRON ]] && cat "$MOCK_CRON" || { echo "no crontab for user" >&2; exit 1; }
elif [[ ${1:-} == "-" ]]; then cat >"$MOCK_CRON"; fi
CRON
  chmod +x "$T/bin/crontab"
  local curl_dir; curl_dir="$(dirname "$(command -v curl)")"
  export PATH="$T/bin:$curl_dir:/usr/bin:/bin"
}
install_cmd() {
  bash "$ROOT/install.sh" --base-url "file://$T/site" --api-url https://example.supabase.co \
    --api-key sb_publishable_test12345 --no-run
}

echo "== Installeur : tests"

new_env
printf 'MAILTO=me@example.com\n0 3 * * * /usr/bin/backup.sh\n' >"$MOCK_CRON"
out=$(install_cmd 2>&1)
check "installation réussie" has "$out" "Installation terminée"
check "agent installé et exécutable" eq "$([[ -x $IK_HOME/.ik-monitor/ik-agent.sh ]] && echo yes)" yes
check "config en mode 600" eq "$(stat -c '%a' "$IK_HOME/.ik-monitor/config")" 600
check "dossier en mode 700" eq "$(stat -c '%a' "$IK_HOME/.ik-monitor")" 700
check "config contient l'URL, la clé et le token" eq "$(grep -c '^IK_' "$IK_HOME/.ik-monitor/config")" 3
check "une seule ligne cron pour l'agent" eq "$(grep -c 'ik-monitor/ik-agent.sh' "$MOCK_CRON")" 1
check "les autres tâches cron sont conservées" has "$(cat "$MOCK_CRON")" "0 3 * * * /usr/bin/backup.sh"
check "la crontab d'origine est sauvegardée" has "$(cat "$IK_HOME/.ik-monitor/crontab.bak")" "backup.sh"
check "sortie muette" has "$(cat "$MOCK_CRON")" ">/dev/null 2>&1"
check "envoi en priorité normale (pas de nice dans le cron)" hasnt "$(cat "$MOCK_CRON")" "nice"
check "le token n'est pas affiché" eq "$([[ $out == *"$TOKEN"* ]] && echo leak || echo ok)" ok

install_cmd >/dev/null 2>&1
check "réinstallation idempotente : toujours une seule ligne" eq "$(grep -c 'ik-monitor/ik-agent.sh' "$MOCK_CRON")" 1

# somme de contrôle incorrecte : rien n'est modifié
new_env
echo "deadbeef  ik-agent.sh" >"$T/site/agent/SHA256SUMS"
out=$(install_cmd 2>&1); rc=$?
check "somme de contrôle incorrecte : échec" eq "$rc" 1
check "somme de contrôle : message explicite" has "$out" "somme de contrôle incorrecte"
check "somme de contrôle : aucun agent installé" eq "$([[ -e $IK_HOME/.ik-monitor/ik-agent.sh ]] && echo yes || echo no)" no
check "somme de contrôle : aucune tâche cron ajoutée" eq "$([[ -e $MOCK_CRON ]] && echo yes || echo no)" no

# paramètres invalides
new_env
out=$(bash "$ROOT/install.sh" --base-url http://exemple.fr --api-url https://x.supabase.co --api-key sb_publishable_test12345 2>&1); rc=$?
check "URL du site non HTTPS refusée" eq "$rc" 1
out=$(bash "$ROOT/install.sh" --base-url "file://$T/site" --api-url http://x.supabase.co --api-key sb_publishable_test12345 2>&1); rc=$?
check "URL d'API non HTTPS refusée" eq "$rc" 1
IK_TOKEN=nimportequoi out=$(install_cmd 2>&1); rc=$?
check "token invalide refusé" eq "$rc" 1

# désinstallation
new_env
printf '0 3 * * * /usr/bin/backup.sh\n' >"$MOCK_CRON"
install_cmd >/dev/null 2>&1
bash "$ROOT/install.sh" --uninstall >/dev/null 2>&1
check "désinstallation : dossier supprimé" eq "$([[ -d $IK_HOME/.ik-monitor ]] && echo yes || echo no)" no
check "désinstallation : ligne cron retirée" eq "$(grep -c 'ik-monitor/ik-agent.sh' "$MOCK_CRON")" 0
check "désinstallation : autres tâches conservées" has "$(cat "$MOCK_CRON")" "backup.sh"

echo; echo "Résultat : $PASS réussis, $FAIL échoués"
((FAIL == 0))
