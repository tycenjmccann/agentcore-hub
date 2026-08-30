# Bug Report: tickets list endpoint drops one item at every page boundary

**Ticket:** BATT-105
**Severity:** medium — silent data loss in list views

## What happened

Listing tickets with `pageSize=25`: page 1 shows 24 items, page 2 starts with
what should have been the 26th item. The 25th ticket never appears on any page.
Same pattern with `pageSize=10` (9 shown, 10th lost). Totals shown in the
footer are correct, so users notice the mismatch.

## Steps to reproduce

1. Seed 30 tickets (any workflow).
2. `GET /api/tickets?page=1&pageSize=25` → returns 24 items.
3. `GET /api/tickets?page=2&pageSize=25` → first item is ticket 26; ticket 25 is on neither page.

## Expected

Page 1 of 25 returns exactly items 1–25; page 2 returns 26–30.
