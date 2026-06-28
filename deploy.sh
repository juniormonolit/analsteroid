#!/bin/bash
set -e
REMOTE="junior@62.113.100.67"
KEY="$HOME/.ssh/ssh-key-1777295854643"
REMOTE_DIR="/home/junior/analsteroid"

echo "==> Building..."
npm run build

echo "==> Packing..."
tar -czf /tmp/analsteroid-deploy.tar.gz \
  .next/standalone/.next/server/ \
  .next/standalone/.next/*.json \
  .next/standalone/.next/BUILD_ID \
  .next/standalone/server.js \
  .next/static/ \
  public/

echo "==> Uploading..."
scp -i "$KEY" -o StrictHostKeyChecking=no /tmp/analsteroid-deploy.tar.gz "$REMOTE:$REMOTE_DIR/deploy.tar.gz"

echo "==> Deploying on server..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$REMOTE" "
  set -e
  cd $REMOTE_DIR

  # Stop server
  kill \$(ss -tlnp | grep 8100 | grep -oP 'pid=\K[0-9]+') 2>/dev/null || true
  sleep 1

  # Extract (overwrite, no node_modules conflict)
  tar -xzf deploy.tar.gz --overwrite

  # Copy static contents into standalone (not the directory itself to avoid nesting)
  mkdir -p .next/standalone/.next/static
  cp -r .next/static/* .next/standalone/.next/static/

  # Copy public into standalone
  cp -r public .next/standalone/public 2>/dev/null || true

  # Start server
  nohup bash start.sh >> app.log 2>&1 & disown
  sleep 4

  # Verify
  BUILD_ID=\$(cat .next/standalone/.next/BUILD_ID)
  STATUS=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/login)
  STATIC=\$(curl -s -o /dev/null -w '%{http_code}' \"http://localhost:8100/_next/static/\${BUILD_ID}/_buildManifest.js\")
  echo \"Login: \$STATUS | Static: \$STATIC | BUILD: \$BUILD_ID\"
"
echo "==> Done!"
