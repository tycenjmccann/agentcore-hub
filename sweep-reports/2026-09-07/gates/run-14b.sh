#!/bin/sh
set +e
pkill -f "next start" || true
: > .sweep-output/gates/14b-run.txt
printf '%s\n' 'pkill command: pkill -f "next start" || true' >> .sweep-output/gates/14b-run.txt
printf '%s\n' 'server command: nohup npm run start -- -p 3737 > .sweep-output/gates/14b-server.log 2>&1 &' >> .sweep-output/gates/14b-run.txt
printf '%s\n' 'wait command: curl -sf -o /dev/null http://localhost:3737/api/health (max 60s)' >> .sweep-output/gates/14b-run.txt
printf '%s\n' 'test command: PLAYWRIGHT_BASE_URL=http://localhost:3737 npm run test:cloud-code -- --trace retain-on-failure > .sweep-output/gates/14b-test-cloud-code.txt 2>&1' >> .sweep-output/gates/14b-run.txt
nohup npm run start -- -p 3737 > .sweep-output/gates/14b-server.log 2>&1 &
server_pid=$!
printf 'server_pid=%s\n' "$server_pid" >> .sweep-output/gates/14b-run.txt
ready=1
for i in $(seq 1 60); do
  if curl -sf -o /dev/null http://localhost:3737/api/health; then
    ready=0
    printf 'health_ready=0 after_seconds=%s\n' "$i" >> .sweep-output/gates/14b-run.txt
    break
  fi
  sleep 1
done
if [ "$ready" -ne 0 ]; then
  printf 'health_ready=1 after_seconds=60\n' >> .sweep-output/gates/14b-run.txt
fi
PLAYWRIGHT_BASE_URL=http://localhost:3737 npm run test:cloud-code -- --trace retain-on-failure > .sweep-output/gates/14b-test-cloud-code.txt 2>&1
test_ec=$?
printf '%s\n' "$test_ec" > .sweep-output/gates/14b-test-cloud-code.exit
printf 'test_exit=%s\n' "$test_ec" >> .sweep-output/gates/14b-run.txt
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
printf 'server_killed=1\n' >> .sweep-output/gates/14b-run.txt
exit 0
