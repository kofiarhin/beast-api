#!/usr/bin/env bash
# Creates the beast-api PM2 process (mirrors the ideahub-api pattern). Touches no other PM2 app.
set -euo pipefail
cd /home/ubuntu/apps/beast-api
pm2 start /usr/bin/env --name beast-api --cwd /home/ubuntu/apps/beast-api \
  --interpreter none --max-memory-restart 400M --kill-timeout 20000 -- \
  -i NODE_ENV=production PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/ubuntu \
  /usr/bin/node --env-file=/home/ubuntu/.config/beast-api/production.env dist/server.js
pm2 save
