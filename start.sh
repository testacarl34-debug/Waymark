#!/usr/bin/env bash
# Waymark process supervisor: keeps the Node server running.
# Restarts it automatically if it ever exits (crash, OOM, idle kill).
cd "$(dirname "$0")"
while true; do
  node server.js >> server.log 2>&1
  echo "$(date -u +%FT%TZ) server exited ($?), restarting in 2s" >> server.log
  sleep 2
done
