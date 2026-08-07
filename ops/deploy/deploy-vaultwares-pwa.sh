#!/usr/bin/env bash
#
# Deploys the mobile vault (PWA) onto greencloud.
#
# Installed at /var/www/deploy-scripts/deploy-vaultwares-pwa.sh and invoked by
# vw-webhookd on a push to main; also safe to run by hand, in which case it
# takes the tip of origin/main.
#
# Served by nginx at warden.vaultwares.ca — the same origin as the API it talks
# to, so there is no CORS to arrange and no second hostname to keep on the
# tailnet. nginx handles /, vault-warden keeps /v1, /health and /docs.
#
set -euo pipefail

REPO_URL="https://github.com/p-potvin/vaultwares-identity-manager.git"
CHECKOUT_DIR="/var/www/vaultwares-pwa-src"
DEPLOY_DIR="/var/www/warden.vaultwares.ca"
LOCK_FILE="/var/lock/vw-deploy-vaultwares-pwa.lock"

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "deploy already running"; exit 1; }

SHA="${VW_AFTER:-${1:-origin/main}}"

export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS="/var/www/deploy-scripts/git-askpass-vw-gh-token.sh"
export VW_GITHUB_OWNER="${VW_GITHUB_OWNER:-p-potvin}"

log() { echo "[deploy-vaultwares-pwa] $*"; }

mkdir -p "$CHECKOUT_DIR" "$DEPLOY_DIR"
if [[ ! -d "$CHECKOUT_DIR/.git" ]]; then
  log "no checkout yet, cloning"
  find "$CHECKOUT_DIR" -mindepth 1 -delete
  git clone "$REPO_URL" "$CHECKOUT_DIR"
fi

cd "$CHECKOUT_DIR"
git fetch --all --prune
git checkout -f "$SHA"
RESOLVED="$(git rev-parse HEAD)"
log "building $RESOLVED"

# The theme submodule is not used by the mobile bundle, but `npm ci` runs
# against a checkout that declares it and a missing one makes for confusing
# failures later.
git submodule sync --recursive
git submodule update --init --depth 1 --recursive

npm ci
npm run build:pwa

if [[ ! -s dist-pwa/index.html || ! -s dist-pwa/mobile.js || ! -s dist-pwa/service-worker.js ]]; then
  log "FAILED: the build did not produce a complete bundle; nothing published"
  ls -la dist-pwa || true
  exit 1
fi

# --delete so a file dropped from the build cannot linger and be served. The
# deploy dir holds nothing but build output, so there is nothing else to lose.
rsync -rltD --delete dist-pwa/ "$DEPLOY_DIR/"
find "$DEPLOY_DIR" -type d -exec chmod 2755 {} +
find "$DEPLOY_DIR" -type f -exec chmod 0644 {} +

echo "$RESOLVED" > "$DEPLOY_DIR/.deployed-sha"
log "ok — $RESOLVED is live at https://warden.vaultwares.ca/"
