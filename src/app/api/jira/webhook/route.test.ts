import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * R1 (docs/race-condition-study.md): the Jira webhook route must enqueue
 * commands on the FIFO queue when WORKFLOW_COMMAND_QUEUE_URL is set — with
 * MessageGroupId = workflow root and a redelivery-stable dedup id — and fall
 * back to the direct orchestrator invoke when it is not. Mock only the seams
 * (SQS + Lambda clients); the real POST handler runs.
 */
const h = vi.hoisted(() => {
  const sqsSends: Array<Record<string, unknown>> = [];
  const lambdaInvokes: Array<Record<string, unknown>> = [];
  // TEAM-5322 F7: ticket-tool invokes (ratify, labels_add) are kept apart from the
  // orchestrator's, and answered by `toolReply`.
  const toolInvokes: Array<{ tool_name: string; parameters: Record<string, unknown> }> = [];
  const state: { toolReply: (call: { tool_name: string }) => unknown } = { toolReply: () => ({}) };
  return { sqsSends, lambdaInvokes, toolInvokes, state };
});

vi.mock("@aws-sdk/client-sqs", () => {
  class SendMessageCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class SQSClient {
    async send(cmd: InstanceType<typeof SendMessageCommand>) {
      h.sqsSends.push(cmd.input);
      return {};
    }
  }
  return { SQSClient, SendMessageCommand };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: { Payload: string | Uint8Array }) {}
  }
  class LambdaClient {
    async send(cmd: InstanceType<typeof InvokeCommand>) {
      const body = JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString());
      if (body.tool_name) {
        h.toolInvokes.push(body);
        return { Payload: Buffer.from(JSON.stringify(h.state.toolReply(body))) };
      }
      h.lambdaInvokes.push(body);
      return {};
    }
  }
  return { LambdaClient, InvokeCommand };
});

function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    webhookEvent: "jira:issue_updated",
    timestamp: 1725000000000,
    issue: {
      key: "TEAM-102",
      fields: {
        summary: "dev ticket",
        status: { name: "Ready" },
        parent: { key: "TEAM-100" },
        labels: [],
      },
    },
    changelog: {
      items: [{ field: "status", fromString: "To Do", toString: "Ready" }],
    },
    ...overrides,
  };
}

async function post(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(
    new NextRequest("http://localhost/api/jira/webhook", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/jira/webhook (queue mode)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    process.env.WORKFLOW_COMMAND_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/agentcore-hub-workflow-commands.fifo";
  });

  it("enqueues a status-change command grouped by the workflow root", async () => {
    const res = await post(webhookPayload());
    expect(res.status).toBe(200);
    expect(h.lambdaInvokes).toHaveLength(0);
    expect(h.sqsSends).toHaveLength(1);
    const msg = h.sqsSends[0];
    expect(msg.MessageGroupId).toBe("TEAM-100");
    expect(JSON.parse(msg.MessageBody as string)).toEqual({
      source: "jira-webhook",
      ticketId: "TEAM-102",
      newStatus: "ready",
      oldStatus: "todo",
    });
  });

  it("groups a parentless root issue under its own key", async () => {
    const payload = webhookPayload();
    delete (payload.issue.fields as Record<string, unknown>).parent;
    await post(payload);
    expect(h.sqsSends[0].MessageGroupId).toBe("TEAM-102");
  });

  it("produces the same dedup id for a redelivered webhook", async () => {
    await post(webhookPayload());
    await post(webhookPayload());
    expect(h.sqsSends[0].MessageDeduplicationId).toBe(h.sqsSends[1].MessageDeduplicationId);
  });

  it("enqueues issue_created as a todo command", async () => {
    await post(webhookPayload({ webhookEvent: "jira:issue_created", changelog: undefined }));
    expect(h.sqsSends).toHaveLength(1);
    const body = JSON.parse(h.sqsSends[0].MessageBody as string);
    expect(body.oldStatus).toBe("new");
  });

  it("ignores updates with no status change", async () => {
    await post(
      webhookPayload({
        changelog: { items: [{ field: "labels", fromString: "", toString: "x" }] },
      })
    );
    expect(h.sqsSends).toHaveLength(0);
  });
});

describe("POST /api/jira/webhook (legacy direct-invoke fallback)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    delete process.env.WORKFLOW_COMMAND_QUEUE_URL;
  });

  it("invokes the orchestrator Lambda directly when no queue is configured", async () => {
    const res = await post(webhookPayload());
    expect(res.status).toBe(200);
    expect(h.sqsSends).toHaveLength(0);
    expect(h.lambdaInvokes).toHaveLength(1);
    expect(h.lambdaInvokes[0]).toEqual({
      source: "jira-webhook",
      ticketId: "TEAM-102",
      newStatus: "ready",
      oldStatus: "todo",
    });
  });
});

describe("POST /api/jira/webhook — a Jira-UI Done on a human gate is ratified (TEAM-5322 F7)", () => {
  const SVC = "svc-account-1";
  const HUMAN = "human-account-7";
  const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
  const gateDone = (accountId: string) =>
    webhookPayload({
      user: { accountId },
      issue: {
        key: "TEAM-5045",
        fields: {
          summary: "Merge Approval: ship it",
          status: { name: "Done" },
          parent: { key: "TEAM-100" },
          labels: ["reviewer:operator", "wf:wf_1"],
        },
      },
      changelog: { items: [{ field: "status", fromString: "In Review", toString: "Done" }] },
    });
  const forwarded = () => JSON.parse(h.sqsSends[0].MessageBody as string);

  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    h.toolInvokes.length = 0;
    fetchCalls.length = 0;
    h.state.toolReply = () => ({});
    process.env.WORKFLOW_COMMAND_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/agentcore-hub-workflow-commands.fifo";
    process.env.JIRA_SITE_URL = "https://example.atlassian.net";
    process.env.JIRA_EMAIL = "svc@example.com";
    process.env.JIRA_API_TOKEN = "test-token";
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
      fetchCalls.push({ url, method: init.method || "GET", body: init.body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/rest/api/3/myself")) return json({ accountId: SVC });
      if (url.endsWith("/transitions") && (init.method || "GET") === "GET") {
        return json({ transitions: [{ id: "31", name: "Back to review", to: { name: "In Review" } }] });
      }
      return new Response(null, { status: 204 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a human Done without a decision → ratify refused → reopened In Review, options comment, re-paged, forwarded as in_review", async () => {
    h.state.toolReply = (call) =>
      call.tool_name === "Tickets___transition_ticket"
        ? { ok: false, reason: "decision_required", ticketId: "TEAM-5045", options: ["approve", "approve-with-known-findings"], detail: "no_decision", error: "refused" }
        : { status: "labels_added" };
    const res = await post(gateDone(HUMAN));
    expect(res.status).toBe(200);

    expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___transition_ticket", "Tickets___labels_add"]);
    expect(h.toolInvokes[0].parameters).toEqual({
      ticket_id: "TEAM-5045",
      transition_id: "done",
      reason: `ratify: Jira UI close by ${HUMAN}`,
    });
    expect(h.toolInvokes[1].parameters).toEqual({ ticket_id: "TEAM-5045", labels: ["gate:awaiting-console"] });

    const reopen = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/issue/TEAM-5045/transitions"));
    expect(JSON.parse(reopen!.body!)).toEqual({ transition: { id: "31" } });
    const comment = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/issue/TEAM-5045/comment"));
    expect(comment!.body).toContain("approve | approve-with-known-findings");

    expect(forwarded()).toEqual({ source: "jira-webhook", ticketId: "TEAM-5045", newStatus: "in_review", oldStatus: "in_review" });
  });

  it("a human Done the twin ratifies is forwarded as done, nothing reopened", async () => {
    h.state.toolReply = () => ({ ticketId: "TEAM-5045", status: "done", ratified: true });
    await post(gateDone(HUMAN));
    expect(h.toolInvokes).toHaveLength(1);
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
    expect(forwarded().newStatus).toBe("done");
  });

  describe("a FAILED ratify fails closed on a decision-bound gate", () => {
    const bound = (accountId: string, description: unknown) => {
      const p = gateDone(accountId);
      (p.issue.fields as Record<string, unknown>).description = description;
      return p;
    };
    const BOUND_ADF = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Merge brief" }] },
        { type: "paragraph", content: [{ type: "text", text: "DECISION OPTIONS: approve | approve-with-known-findings" }] },
      ],
    };
    const throwOnRatify = () => {
      h.state.toolReply = (call) => {
        if (call.tool_name === "Tickets___transition_ticket") throw new Error("Lambda unavailable");
        return { status: "labels_added" };
      };
    };
    const reopened = () => fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/issue/TEAM-5045/transitions"));
    const commented = () => fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/issue/TEAM-5045/comment"));

    it("ratify throws on a bound gate (ADF description) → reopened, options comment, re-paged, forwarded in_review", async () => {
      throwOnRatify();
      await post(bound(HUMAN, BOUND_ADF));
      expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___transition_ticket", "Tickets___labels_add"]);
      expect(h.toolInvokes[1].parameters).toEqual({ ticket_id: "TEAM-5045", labels: ["gate:awaiting-console"] });
      expect(JSON.parse(reopened()!.body!)).toEqual({ transition: { id: "31" } });
      expect(commented()!.body).toContain("approve | approve-with-known-findings");
      expect(forwarded().newStatus).toBe("in_review");
    });

    it("a non-ok, non-admission answer on a bound gate fails closed; the description is fetched when the payload has none", async () => {
      h.state.toolReply = (call) =>
        call.tool_name === "Tickets___transition_ticket" ? { ok: false, reason: "gate_unverified", error: "refused" } : {};
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
        if (url.includes("/issue/TEAM-5045?fields=description")) {
          fetchCalls.push({ url, method: "GET" });
          return new Response(JSON.stringify({ key: "TEAM-5045", fields: { description: "DECISION OPTIONS: continue | cancel" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return realFetch(url, init as RequestInit);
      });
      await post(gateDone(HUMAN));
      expect(fetchCalls.some((c) => c.url.includes("/issue/TEAM-5045?fields=description"))).toBe(true);
      expect(reopened()).toBeTruthy();
      expect(commented()!.body).toContain("continue | cancel");
      expect(forwarded().newStatus).toBe("in_review");
    });

    it("ratify throws on an UNBOUND gate → passes through as done, nothing reopened", async () => {
      throwOnRatify();
      await post(bound(HUMAN, "Approve this gate to continue."));
      expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___transition_ticket"]);
      expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
      expect(forwarded().newStatus).toBe("done");
    });

    it("a service-account Done on a bound gate still passes through (no ratify)", async () => {
      throwOnRatify();
      await post(bound(SVC, BOUND_ADF));
      expect(h.toolInvokes).toHaveLength(0);
      expect(forwarded().newStatus).toBe("done");
    });
  });

  describe("TEAM-5338 F7: every unknown fails closed - Done is never forwarded on a guess", () => {
    const BOUND_TEXT = "Merge brief\nDECISION OPTIONS: approve | reject";
    const withDescription = (description: unknown) => {
      const p = gateDone(HUMAN);
      (p.issue.fields as Record<string, unknown>).description = description;
      return p;
    };
    const jsonEvents = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls
        .map((args: unknown[]) => {
          try {
            return JSON.parse(String(args[0]));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    /** Route Jira by path; anything unlisted answers 204. */
    const jiraWith = (routes: Record<string, (init: { method?: string }) => Response | null>) =>
      vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
        fetchCalls.push({ url, method: init.method || "GET", body: init.body });
        for (const [frag, fn] of Object.entries(routes)) {
          if (url.includes(frag)) {
            const r = fn(init);
            if (r) return r;
          }
        }
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/rest/api/3/myself")) return json({ accountId: SVC });
        if (url.endsWith("/transitions") && (init.method || "GET") === "GET") {
          return json({ transitions: [{ id: "31", name: "Back to review", to: { name: "In Review" } }] });
        }
        return new Response(null, { status: 204 });
      });
    const down = () => new Response("nope", { status: 503 });
    const reopenPosts = () => fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/issue/TEAM-5045/transitions"));
    const comments = () => fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/issue/TEAM-5045/comment"));

    it("an unresolvable service account on a bound gate does NOT forward done: reopened, re-paged, logs jira_webhook_ratify_unavailable", async () => {
      jiraWith({ "/rest/api/3/myself": down });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await post(withDescription(BOUND_TEXT));
        expect(res.status).toBe(200);
        expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___labels_add"]);
        expect(reopenPosts()).toHaveLength(1);
        expect(comments()[0].body).toContain("approve | reject");
        expect(forwarded().newStatus).toBe("in_review");
        expect(jsonEvents(warn)).toContainEqual({ event: "jira_webhook_ratify_unavailable", issueKey: "TEAM-5045", actor: HUMAN, why: "service_account_unresolved" });
      } finally {
        warn.mockRestore();
      }
    });

    it("an unresolvable service account with Jira down entirely forwards nothing and answers 503", async () => {
      vi.stubGlobal("fetch", async (url: string, init: { method?: string } = {}) => {
        fetchCalls.push({ url, method: init.method || "GET" });
        return down();
      });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await post(gateDone(HUMAN));
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ error: "gate_reopen_failed", forwarded: false });
        expect(h.sqsSends).toHaveLength(0);
      } finally {
        err.mockRestore();
      }
    });

    it("a failed ratify whose description cannot be read is not treated as unbound: reopened, never done", async () => {
      h.state.toolReply = (call) => {
        if (call.tool_name === "Tickets___transition_ticket") throw new Error("Lambda unavailable");
        return { status: "labels_added" };
      };
      jiraWith({ "/issue/TEAM-5045?fields=description": () => down() });
      await post(gateDone(HUMAN));
      expect(fetchCalls.some((c) => c.url.includes("/issue/TEAM-5045?fields=description"))).toBe(true);
      expect(reopenPosts()).toHaveLength(1);
      expect(comments()[0].body).toContain("Decide it again");
      expect(forwarded().newStatus).toBe("in_review");
    });

    it("a reopen whose transition fails does not report in_review and does not forward done (503, still re-paged)", async () => {
      h.state.toolReply = (call) =>
        call.tool_name === "Tickets___transition_ticket"
          ? { ok: false, reason: "decision_required", options: ["approve", "reject"], error: "refused" }
          : { status: "labels_added" };
      jiraWith({ "/issue/TEAM-5045/transitions": (init) => ((init.method || "GET") === "POST" ? down() : null) });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await post(gateDone(HUMAN));
        expect(res.status).toBe(503);
        expect(h.sqsSends).toHaveLength(0);
        expect(comments()[0].body).toContain("could not be reopened; it is NOT treated as done");
        expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___transition_ticket", "Tickets___labels_add"]);
      } finally {
        err.mockRestore();
      }
    });

    it("repeat failures on one gate within 10 minutes page once; another gate still pages; the window reopens", async () => {
      h.state.toolReply = (call) =>
        call.tool_name === "Tickets___transition_ticket"
          ? { ok: false, reason: "decision_required", options: ["approve", "reject"], error: "refused" }
          : { status: "labels_added" };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        vi.resetModules();
        const { POST } = await import("./route");
        const send = (body: unknown) =>
          POST(new NextRequest("http://localhost/api/jira/webhook", { method: "POST", body: JSON.stringify(body) }));
        const other = gateDone(HUMAN);
        other.issue.key = "TEAM-5046";

        await send(gateDone(HUMAN));
        vi.setSystemTime(new Date("2026-10-06T10:05:00Z"));
        await send(gateDone(HUMAN));
        await send(other);
        const pages = () => h.toolInvokes.filter((c) => c.tool_name === "Tickets___labels_add").map((c) => c.parameters.ticket_id);
        expect(pages()).toEqual(["TEAM-5045", "TEAM-5046"]);
        expect(comments()).toHaveLength(1);
        expect(reopenPosts()).toHaveLength(2); // the reopen itself is never throttled
        expect(jsonEvents(warn)).toContainEqual({ event: "jira_webhook_repage_throttled", issueKey: "TEAM-5045", outcome: "in_review" });

        vi.setSystemTime(new Date("2026-10-06T10:11:00Z"));
        await send(gateDone(HUMAN));
        expect(pages()).toEqual(["TEAM-5045", "TEAM-5046", "TEAM-5045"]);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it("an unresolvable service account on a gate KNOWN to bind nothing still passes through as done", async () => {
      jiraWith({ "/rest/api/3/myself": down });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await post(withDescription("Approve this gate to continue."));
        expect(reopenPosts()).toHaveLength(0);
        expect(forwarded().newStatus).toBe("done");
      } finally {
        warn.mockRestore();
      }
    });

    // TEAM-5347 F4: "declares no DECISION OPTIONS" is not "binds nothing" for a TYPED
    // gate — its Done needs the twin's probe (deploy-approval, blocker, ci-unavailable).
    describe("TEAM-5347 F4: a typed gate is never unbound, and an unknown actor fails closed", () => {
      const typedDone = (labels: string[], accountId: string | null = HUMAN) => {
        const p = withDescription("Deploy hub-x to prod when the pipeline is green.");
        (p.issue.fields as { labels: string[] }).labels = labels;
        if (accountId === null) delete (p as { user?: unknown }).user;
        else (p as { user?: { accountId: string } }).user = { accountId };
        return p;
      };
      const DEPLOY = ["gate:deploy-approval", "pipeline:hub-x-deploy", "exec:abc", "wf:wf_1"];

      it("typed gate (no reviewer label, no options) + /myself down ⇒ reopened and paged, never forwarded as done", async () => {
        jiraWith({ "/rest/api/3/myself": down });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await post(typedDone(DEPLOY));
          expect(reopenPosts()).toHaveLength(1);
          expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___labels_add"]);
          expect(comments()[0].body).toContain("Decide it again");
          expect(forwarded().newStatus).toBe("in_review");
          expect(warn.mock.calls.some((a) => /typed gate \(deploy-approval\)/.test(String(a[0])))).toBe(true);
        } finally {
          warn.mockRestore();
        }
      });

      it("typed gate + ratify throws ⇒ reopened, not forwarded (the twin's probe was never consulted)", async () => {
        h.state.toolReply = (call) => {
          if (call.tool_name === "Tickets___transition_ticket") throw new Error("Lambda unavailable");
          return { status: "labels_added" };
        };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await post(typedDone(["reviewer:operator", ...DEPLOY]));
          expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___transition_ticket", "Tickets___labels_add"]);
          expect(reopenPosts()).toHaveLength(1);
          expect(forwarded().newStatus).toBe("in_review");
        } finally {
          warn.mockRestore();
        }
      });

      it("a typed gate the twin ratifies is forwarded as done", async () => {
        h.state.toolReply = (call) => (call.tool_name === "Tickets___transition_ticket" ? { ok: true, status: "done", ratified: true } : {});
        await post(typedDone(DEPLOY));
        expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___transition_ticket"]);
        expect(reopenPosts()).toHaveLength(0);
        expect(forwarded().newStatus).toBe("done");
      });

      it("a Done with no `user` on a decision-bound gate ⇒ reopened and paged (actor_unknown), never ratified blind", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const p = withDescription(BOUND_TEXT);
          delete (p as { user?: unknown }).user;
          await post(p);
          expect(h.toolInvokes.map((c) => c.tool_name)).toEqual(["Tickets___labels_add"]);
          expect(reopenPosts()).toHaveLength(1);
          expect(forwarded().newStatus).toBe("in_review");
          expect(jsonEvents(warn)).toContainEqual({ event: "jira_webhook_ratify_unavailable", issueKey: "TEAM-5045", actor: null, why: "actor_unknown" });
          expect(fetchCalls.some((c) => c.url.endsWith("/rest/api/3/myself"))).toBe(false);
        } finally {
          warn.mockRestore();
        }
      });

      it("a Done with no `user` on a plain gate that binds nothing still passes through as done", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const p = withDescription("Approve this gate to continue.");
          delete (p as { user?: unknown }).user;
          await post(p);
          expect(reopenPosts()).toHaveLength(0);
          expect(forwarded().newStatus).toBe("done");
        } finally {
          warn.mockRestore();
        }
      });

      it("a Done with no `user` on an agent ticket is unchanged (not a gate)", async () => {
        const p = gateDone(HUMAN);
        (p.issue.fields as { labels: string[] }).labels = ["agent:agentcore_hub_backend_dev"];
        delete (p as { user?: unknown }).user;
        await post(p);
        expect(h.toolInvokes).toHaveLength(0);
        expect(fetchCalls).toHaveLength(0);
        expect(forwarded().newStatus).toBe("done");
      });
    });

    // TEAM-5347 F5: the throttle slot is taken when the page LANDS, not when it is attempted.
    it("a page whose label write fails leaves the throttle open: the redelivery a minute later pages; a landed page then throttles", async () => {
      let labelFailures = 1;
      h.state.toolReply = (call) => {
        if (call.tool_name === "Tickets___transition_ticket") return { ok: false, reason: "decision_required", options: ["approve", "reject"], error: "refused" };
        if (labelFailures-- > 0) throw new Error("Lambda unavailable");
        return { status: "labels_added" };
      };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        vi.resetModules();
        const { POST } = await import("./route");
        const send = (body: unknown) =>
          POST(new NextRequest("http://localhost/api/jira/webhook", { method: "POST", body: JSON.stringify(body) }));
        const pages = () => h.toolInvokes.filter((c) => c.tool_name === "Tickets___labels_add").length;

        await send(gateDone(HUMAN));
        expect(pages()).toBe(1);
        expect(jsonEvents(warn)).toContainEqual({ event: "jira_webhook_repage_failed", issueKey: "TEAM-5045", outcome: "in_review", error: "Error" });

        vi.setSystemTime(new Date("2026-10-06T10:01:00Z"));
        await send(gateDone(HUMAN));
        expect(pages()).toBe(2);
        expect(jsonEvents(warn).filter((e: { event: string }) => e.event === "jira_webhook_repage_throttled")).toHaveLength(0);

        vi.setSystemTime(new Date("2026-10-06T10:02:00Z"));
        await send(gateDone(HUMAN));
        expect(pages()).toBe(2);
        expect(jsonEvents(warn)).toContainEqual({ event: "jira_webhook_repage_throttled", issueKey: "TEAM-5045", outcome: "in_review" });
        expect(comments()).toHaveLength(2);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("a service-account Done passes through unchanged (no ratify)", async () => {
    await post(gateDone(SVC));
    expect(h.toolInvokes).toHaveLength(0);
    expect(forwarded().newStatus).toBe("done");
  });

  it("an agent ticket's Done is never ratified (not a human gate)", async () => {
    const p = gateDone(HUMAN);
    (p.issue.fields as { labels: string[] }).labels = ["agent:agentcore_hub_backend_dev"];
    await post(p);
    expect(h.toolInvokes).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(forwarded().newStatus).toBe("done");
  });
});
