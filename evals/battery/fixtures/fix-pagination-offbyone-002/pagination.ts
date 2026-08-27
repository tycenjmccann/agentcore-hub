// Sanitized battery fixture — pagination helper for sample-service list endpoints.

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function paginate<T>(all: T[], page: number, pageSize: number): Page<T> {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const start = (safePage - 1) * safeSize;
  // BUG LIVES HERE: upper bound excludes the boundary item.
  const end = start + safeSize - 1;
  return {
    items: all.slice(start, end),
    page: safePage,
    pageSize: safeSize,
    total: all.length,
  };
}
