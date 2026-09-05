# Bug Report: settings API route returns 500 when the session cookie is missing

**Ticket:** BATT-104
**Severity:** high — logged-out users hitting /api/settings crash the route instead of getting 401

## What happened

Requests to `GET /api/settings` without a session cookie (expired session,
cleared cookies, or a direct curl) return HTTP 500. Server log:

```
TypeError: Cannot read properties of null (reading 'tenantId')
    at getTenantScope (src/lib/session-utils.ts:24:18)
    at GET (src/app/api/settings/route.ts:11:23)
```

## Steps to reproduce

1. Clear cookies (or use a fresh curl with no Cookie header).
2. `curl -i https://localhost:3000/api/settings`
3. Observe 500 instead of 401.

## Expected

An unauthenticated request should get a 401 JSON response, never a 500.

## Notes

`parseSession` returns `null` for a missing cookie by design (see
session-utils.ts, included alongside this report). The crash is downstream of
that contract.
