# Routines E2E Probe

End-to-end probe that continuously validates the Routines API by exercising the full lifecycle: health check, create routine, trigger execution, poll for completion, and cleanup.

## Build

```bash
cd test/probe
go build -o probe ./cmd/probe
```

## Docker

```bash
docker build -t routines-e2e-probe .
```

## Usage

### Single run (CI/pre-deploy)

```bash
./probe --target-url https://routines.example.com --auth-token "$TOKEN" --once
# Exit code: 0=pass, 1=fail, 2=config error
```

### Continuous mode (default)

```bash
./probe --target-url https://routines.example.com --auth-token "$TOKEN" --interval 5m
```

### Environment variables

All flags can be set via environment variables with `PROBE_` prefix:

```bash
export PROBE_TARGET_URL=https://routines.example.com
export PROBE_AUTH_TOKEN=secret
export PROBE_INTERVAL=2m
./probe
```

## Health Endpoint

The probe exposes a `/healthz` endpoint (default `:8080`) that returns 200 when the last probe run passed, or 503 when unhealthy.

## Configuration

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--target-url` | `PROBE_TARGET_URL` | (required) | Target service base URL |
| `--auth-token` | `PROBE_AUTH_TOKEN` | (required) | Bearer token |
| `--interval` | `PROBE_INTERVAL` | `5m` | Probe run interval |
| `--exec-timeout` | `PROBE_EXEC_TIMEOUT` | `30s` | Execution polling timeout |
| `--create-timeout` | `PROBE_CREATE_TIMEOUT` | `5s` | HTTP timeout for create calls |
| `--health-timeout` | `PROBE_HEALTH_TIMEOUT` | `2s` | Health check timeout |
| `--poll-interval` | `PROBE_POLL_INTERVAL` | `2s` | Execution poll interval |
| `--failure-threshold` | `PROBE_FAILURE_THRESHOLD` | `3` | Consecutive failures before alert |
| `--once` | `PROBE_ONCE` | `false` | Run once and exit |
| `--listen-addr` | `PROBE_LISTEN_ADDR` | `:8080` | Health endpoint address |
| `--log-level` | `PROBE_LOG_LEVEL` | `info` | Log level |
| `--idem-prefix` | `PROBE_IDEM_PREFIX` | `e2e-probe` | Idempotency key prefix |
| `--cleanup-stale` | `PROBE_CLEANUP_STALE` | `true` | Clean up stale routines |
