#!/bin/bash
set -e
REMOTE="junior@62.113.100.67"
KEY="$HOME/.ssh/ssh-key-1777295854643"
REMOTE_DIR="/home/junior/analsteroid"

BRANCH="dev-asteroid"

# ── Гард свежести (правило «Git и деплой» в CLAUDE.md) ────────────────────────
# Над dev-asteroid работают несколько агентов параллельно, и локальное дерево
# устаревает за минуты. Если выкатить коммит, в который origin/dev-asteroid не влит,
# прод откатится к состоянию БЕЗ чужих коммитов — это уже случалось. Проверяем до
# сборки, чтобы не тратить пару минут на build, который всё равно нельзя катить.
# Осознанный обход (например, срочный откат на старый коммит) — ALLOW_STALE_DEPLOY=1.
if [ "${ALLOW_STALE_DEPLOY:-0}" != "1" ]; then
  echo "==> Проверка свежести относительно origin/$BRANCH..."
  if git fetch origin "$BRANCH" --quiet 2>/dev/null; then
    if ! git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
      BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH")
      echo "!! origin/$BRANCH НЕ влит в HEAD — такая выкатка откатит прод."
      echo "   Отстаём на $BEHIND коммит(ов). Сначала: git pull origin $BRANCH"
      echo "   Если откат нужен осознанно: ALLOW_STALE_DEPLOY=1 bash deploy.sh"
      exit 1
    fi
    echo "    ок — origin/$BRANCH влит в HEAD"
  else
    echo "    !! не удалось получить origin/$BRANCH (нет сети?) — проверка пропущена"
  fi
fi

echo "==> Building..."
npm run build

# Turbopack's file tracer chokes on the dynamic fs.readFileSync(path.join(process.cwd(), ...))
# in lib/db/clients.ts (YC_PG_SSL_CA_PATH) and silently drops packages from
# .next/standalone/node_modules instead of tracing them properly. Verified after adding
# ioredis: only its package.json landed there, no code, no transitive deps. Until that's
# fixed upstream (or the dynamic path is removed), explicitly re-copy any package whose
# standalone copy is missing its actual code — cheap, idempotent, harmless once tracing
# is fixed since it'd just re-copy identical files.
echo "==> Patching standalone node_modules (Turbopack NFT tracing gaps)..."
NEEDED_PKGS=(ioredis @ioredis/commands cluster-key-slot debug denque redis-errors redis-parser standard-as-callback ms)
for pkg in "${NEEDED_PKGS[@]}"; do
  src="node_modules/$pkg"
  dest=".next/standalone/node_modules/$pkg"
  if [ -d "$src" ] && [ "$(find "$dest" -type f 2>/dev/null | wc -l | tr -d ' ')" -lt "$(find "$src" -type f | wc -l | tr -d ' ')" ]; then
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    cp -R "$src" "$dest"
    echo "  patched $pkg"
  fi
done

echo "==> Patching pg module (Turbopack NFT tracing gap — MANDATORY since deploy #27, see team/devops.md 'NEEDED_PKGS = 10 пакетов')..."
# .next/standalone/.next/node_modules/pg-<hash> is where Turbopack resolves the external
# `pg` package at runtime; NFT tracing leaves it as a symlink to .next/standalone/node_modules/pg
# (or an empty dir), and that standalone copy itself is sometimes incomplete (18/20 files,
# observed deploy #30). Always overwrite with the ROOT node_modules/pg (guaranteed complete),
# regardless of what NFT left behind — cheap and idempotent.
PG_DEST=$(find .next/standalone/.next/node_modules -maxdepth 1 \( -type l -o -type d \) -name 'pg-*' 2>/dev/null | head -1)
if [ -z "$PG_DEST" ]; then
  echo "  !! pg-<hash> not found under .next/standalone/.next/node_modules — CHECK MANUALLY (see team/devops.md)"
else
  rm -rf "$PG_DEST"
  mkdir -p "$PG_DEST"
  cp -R node_modules/pg/. "$PG_DEST/"
  PG_FILES=$(find "$PG_DEST" -type f | wc -l | tr -d ' ')
  ROOT_FILES=$(find node_modules/pg -type f | wc -l | tr -d ' ')
  echo "  patched $PG_DEST ($PG_FILES files, root has $ROOT_FILES)"
  if [ "$PG_FILES" != "$ROOT_FILES" ]; then
    echo "  !! file count mismatch after patch — investigate before deploying"
    exit 1
  fi
fi

echo "==> Packing..."
# public/ is optional — this project has none; only include it when present.
PACK_PATHS=(
  .next/standalone/.next/server/
  .next/standalone/.next/*.json
  .next/standalone/.next/BUILD_ID
  .next/standalone/server.js
  .next/static/
)
[ -d public ] && PACK_PATHS+=(public/)
# Merge only the patched packages into remote's node_modules (not the whole tree — remote's
# existing node_modules provenance predates this script and shouldn't be replaced wholesale).
for pkg in "${NEEDED_PKGS[@]}"; do
  [ -d ".next/standalone/node_modules/$pkg" ] && PACK_PATHS+=(".next/standalone/node_modules/$pkg/")
done
[ -n "$PG_DEST" ] && PACK_PATHS+=("$PG_DEST/")
tar -czf /tmp/analsteroid-deploy.tar.gz "${PACK_PATHS[@]}"

echo "==> Uploading..."
scp -i "$KEY" -o StrictHostKeyChecking=no /tmp/analsteroid-deploy.tar.gz "$REMOTE:$REMOTE_DIR/deploy.tar.gz"

echo "==> Deploying on server..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$REMOTE" "
  set -e
  cd $REMOTE_DIR

  # Stop server
  kill \$(ss -tlnp | grep 8100 | grep -oP 'pid=\K[0-9]+') 2>/dev/null || true
  sleep 1

  # pg-<hash> may currently be a SYMLINK on the server (from an older deploy before this
  # fix existed) — tar --overwrite won't cleanly replace a symlink with a real directory,
  # so remove it explicitly first; the tarball always contains a real directory for it.
  $([ -n "$PG_DEST" ] && echo "rm -rf '$PG_DEST'")

  # Extract (overwrite, no node_modules conflict)
  tar -xzf deploy.tar.gz --overwrite

  # Copy static contents into standalone (not the directory itself to avoid nesting)
  mkdir -p .next/standalone/.next/static
  cp -r .next/static/* .next/standalone/.next/static/

  # Copy public into standalone (remove stale copy first: cp -r nests into an
  # already-existing dest dir instead of replacing it)
  if [ -d public ]; then
    rm -rf .next/standalone/public
    cp -r public .next/standalone/public
  fi

  # Start server
  nohup bash start.sh >> app.log 2>&1 & disown
  sleep 4

  # Verify
  BUILD_ID=\$(cat .next/standalone/.next/BUILD_ID)
  STATUS=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/login)
  STATIC=\$(curl -s -o /dev/null -w '%{http_code}' \"http://localhost:8100/_next/static/\${BUILD_ID}/_buildManifest.js\")
  echo \"Login: \$STATUS | Static: \$STATIC | BUILD: \$BUILD_ID\"

  # pg module sanity check (mandatory, see team/devops.md) — any DB route
  # depends on this resolving; a silent MODULE_NOT_FOUND here means every
  # /api/* route touching the DB is broken even though /login still returns 200.
  PG_FILES=\$(find '$PG_DEST' -type f 2>/dev/null | wc -l | tr -d ' ')
  PG_REQUIRE_OK=\$(node -e \"require('$REMOTE_DIR/$PG_DEST'); console.log('ok')\" 2>&1 || true)
  echo \"pg module: \$PG_FILES files in $PG_DEST, require(): \$PG_REQUIRE_OK\"
"
echo "==> Done!"
