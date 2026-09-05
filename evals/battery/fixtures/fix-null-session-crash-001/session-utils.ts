// Sanitized battery fixture — session helpers for sample-service.
// parseSession returns null when no valid cookie is present (by design).

export interface Session {
  userId: string;
  tenantId: string;
  expiresAt: string; // ISO timestamp
}

export function parseSession(cookieHeader: string | null): Session | null {
  if (!cookieHeader) return null;
  const match = /session=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  try {
    const decoded = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (!decoded.userId || !decoded.tenantId) return null;
    if (new Date(decoded.expiresAt) < new Date()) return null;
    return decoded as Session;
  } catch {
    return null;
  }
}

// BUG LIVES HERE: callers pass parseSession() output straight in; a null
// session dereferences .tenantId and throws instead of yielding a 401 path.
export function getTenantScope(session: Session): string {
  return `tenants/${session.tenantId}/`;
}
