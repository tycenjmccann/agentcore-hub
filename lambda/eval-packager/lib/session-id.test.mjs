/**
 * Session-id parsing (TEAM-4688).
 *
 * The parse is the ONLY source of the workflowId/ticketId/persona dimensions on
 * a stored judge result, so a wrong answer here silently mis-files data: a
 * canary result attributed to a real run, or a persona bucket that never fills.
 * Pure functions, no AWS, no mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  RUNTIME_PERSONA,
  parseSessionId,
  personaFor,
  roleFromSessionId,
} from './session-id.mjs';

const RUNTIME = 'agentcore_hub_agent';

describe('parseSessionId', () => {
  it('parses a ticket-prefixed pipeline id (the common case)', () => {
    expect(parseSessionId('TEAM-4123_wf_1757900000000_k3j9xq-agentcore_hub_backend_dev-1757900123456'))
      .toEqual({
        ticketId: 'TEAM-4123',
        workflowId: 'wf_1757900000000_k3j9xq',
        agentId: 'agentcore_hub_backend_dev',
        startedAt: 1757900123456,
      });
  });

  it('parses an un-prefixed pipeline id (run started without a ticket)', () => {
    expect(parseSessionId('wf_1757900000000_k3j9xq-agentcore_hub_requirements_analyst-1757900123456'))
      .toEqual({
        ticketId: null,
        workflowId: 'wf_1757900000000_k3j9xq',
        agentId: 'agentcore_hub_requirements_analyst',
        startedAt: 1757900123456,
      });
  });

  it('parses a bug-run id, whose workflowId itself contains a hyphenated ticket key', () => {
    // wf_bug_<TICKET> (orchestrator index.mjs) — the lazy workflowId group must
    // not swallow the `-<agentId>-<ts>` tail, and must not stop at the ticket's
    // own hyphen either.
    expect(parseSessionId('TEAM-4577_wf_bug_TEAM-4577-agentcore_hub_bug_fixer-1757900123456'))
      .toEqual({
        ticketId: 'TEAM-4577',
        workflowId: 'wf_bug_TEAM-4577',
        agentId: 'agentcore_hub_bug_fixer',
        startedAt: 1757900123456,
      });
  });

  it('honours a non-default project key', () => {
    const parsed = parseSessionId('MYPROJ-7_wf_1757900000000_abc123-agentcore_hub_ci_agent-1757900123456');
    expect(parsed.ticketId).toBe('MYPROJ-7');
    expect(parsed.workflowId).toBe('wf_1757900000000_abc123');
  });

  it.each([
    ['si-agentcore_hub_agent-1757900123456---------------', 'self-improvement (padded to 33 chars)'],
    ['cc-3f7a1b9c4d2e4f8a9b0c1d2e3f4a5b6c', 'cloud code'],
    ['canary-eval-1757900123-agentcore_hub_agent', 'canary (epoch seconds, agent id last)'],
    ['wmchat-conv-42000000000000000000000000', 'workflow-manager chat'],
    ['rtchat-conv-90000000000000000000000000', 'routines chat'],
    ['battery-run7-case3', 'config-evals battery'],
    ['', 'empty'],
    ['wf_1757900000000_k3j9xq-agentcore_hub_backend_dev-17579001', 'short timestamp'],
    ['prefix wf_1_a-agentcore_hub_x-1757900123456', 'unanchored prefix'],
  ])('returns null for %s (%s)', (sid) => {
    expect(parseSessionId(sid)).toBeNull();
  });

  it('returns null for non-strings rather than throwing', () => {
    expect(parseSessionId(undefined)).toBeNull();
    expect(parseSessionId(null)).toBeNull();
    expect(parseSessionId(42)).toBeNull();
  });
});

describe('personaFor', () => {
  it('names the persona that ran a pipeline session', () => {
    expect(personaFor('TEAM-1_wf_1_a-agentcore_hub_code_reviewer-1757900123456', RUNTIME))
      .toBe('agentcore_hub_code_reviewer');
  });

  it('files a session with no persona in the id under the runtime', () => {
    expect(personaFor('cc-3f7a1b9c4d2e4f8a9b0c1d2e3f4a5b6c', RUNTIME)).toBe(RUNTIME_PERSONA);
    expect(personaFor('canary-eval-1757900123-agentcore_hub_agent', RUNTIME)).toBe(RUNTIME_PERSONA);
    expect(personaFor(null, RUNTIME)).toBe(RUNTIME_PERSONA);
  });

  it('files a session whose persona IS the hosting runtime under the runtime', () => {
    // si- ids end in `-<agentId>-<13 digits>`, so the role parse succeeds with
    // the runtime's own id. Treating that as a persona would invent an
    // `agentcore_hub_agent#agentcore_hub_agent` bucket.
    expect(personaFor(`si-${RUNTIME}-1757900123456`, RUNTIME)).toBe(RUNTIME_PERSONA);
    expect(roleFromSessionId(`si-${RUNTIME}-1757900123456`)).toBe(RUNTIME);
  });
});
