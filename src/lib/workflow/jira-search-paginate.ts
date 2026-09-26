/**
 * TEAM-5171: bounded, transport-agnostic pager for Jira's /rest/api/3/search/jql.
 *
 * The endpoint returns at most one page (≤100 issues) plus `isLast` /
 * `nextPageToken`. Reading only the first page made isWorkflowComplete report
 * complete with >100 children, cancel leave children open, and nudge/board scans
 * see a partial set. Every web-tier caller goes through here with its OWN
 * transport (auth + base URL) via `fetchPage`; a scan that could not reach the
 * last page comes back `truncated: true` and must never be treated as complete.
 */

/** Same default as the metrics route's jiraFetchAll. */
export const JQL_SEARCH_CAP = 1000;

export interface JqlPage<T> {
  issues?: T[];
  isLast?: boolean;
  nextPageToken?: string;
}

export interface SearchJqlAllOptions<T> {
  /** Caller's transport. Must throw on a non-ok response — errors propagate. */
  fetchPage: (params: URLSearchParams) => Promise<JqlPage<T>>;
  jql: string;
  /** Comma-separated field list. */
  fields: string;
  pageSize?: number;
  cap?: number;
}

/** Thrown by callers that cannot act on a partial scan. */
export class JiraSearchTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraSearchTruncatedError";
  }
}

export async function searchJqlAll<T>(opts: SearchJqlAllOptions<T>): Promise<{ issues: T[]; truncated: boolean }> {
  const pageSize = opts.pageSize ?? 100;
  const cap = opts.cap ?? JQL_SEARCH_CAP;
  const maxPages = Math.ceil(cap / pageSize) + 1;
  const issues: T[] = [];
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;

  for (let pages = 0; ; pages++) {
    // Empty pages that keep saying "not last" with fresh tokens would never hit the cap.
    if (pages >= maxPages) return { issues, truncated: true };

    const params = new URLSearchParams({
      jql: opts.jql,
      fields: opts.fields,
      maxResults: String(Math.min(pageSize, cap - issues.length)),
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);

    const page = await opts.fetchPage(params);
    issues.push(...(page.issues || []));

    // A missing isLast is treated as the last page (matches jiraFetchAll).
    if (page.isLast !== false) return { issues: issues.slice(0, cap), truncated: false };
    if (issues.length >= cap) return { issues: issues.slice(0, cap), truncated: true };
    if (!page.nextPageToken || seenTokens.has(page.nextPageToken)) return { issues, truncated: true };

    seenTokens.add(page.nextPageToken);
    nextPageToken = page.nextPageToken;
  }
}
