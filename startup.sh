#!/bin/sh
set -eu
cd /workspace

LOCAL_URL="postgres://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable"

port_open() {
  node -e "const n=require('net'); const s=n.connect(54329,'127.0.0.1',()=>{s.end(); process.exit(0)}); s.on('error',()=>process.exit(1))"
}

if [ -z "${DATABASE_URL:-}" ] || [ "$DATABASE_URL" = "$LOCAL_URL" ]; then
  export DATABASE_URL="$LOCAL_URL"
  if ! port_open; then
    node scripts/database.mjs >> /tmp/meridian-db.log 2>&1 &
    echo $! > /tmp/meridian-database.pid
    i=0
    while [ "$i" -lt 50 ]; do
      if port_open; then
        break
      fi
      i=$((i + 1))
      sleep 0.2
    done
    port_open
  fi
fi

node scripts/migrate.mjs

start_proc() {
  name=$1
  shift
  pidfile=/tmp/meridian-$name.pid
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" || true)
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
      return 0
    fi
  fi
  "$@" >> /tmp/meridian-$name.log 2>&1 &
  echo $! > "$pidfile"
}

start_proc scheduler node --experimental-strip-types scripts/scheduler-entry.ts
start_proc worker node --experimental-strip-types scripts/worker-entry.ts

if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev > /tmp/meridian-dev.log 2>&1 &
exit 0
