import { test, expect, type Page } from "@playwright/test";

/**
 * TEAM-5452: Agent Detail "Register" / "Registered ✓" (Registry module slot).
 *
 * Hermetic via page.route() — the agent detail and registry routes are stubbed
 * (shapes mirror the route handlers, see stub()), so no AWS call and no
 * registry write happens here. This is NOT live verification: the real
 * round-trip is a separate, manual step (see the PR).
 */

const AGENT_ID = "fake_agent-AbC123";
// Obviously fake account/region: the mapping must only ever echo these back.
const AGENT_ARN = `arn:aws:bedrock-agentcore:eu-west-3:000011112222:runtime/${AGENT_ID}`;

const AGENT = {
  id: AGENT_ID,
  name: "fake_agent",
  arn: AGENT_ARN,
  type: "runtime",
  status: "READY",
  description: "A fake agent for the register spec.",
  tools: [{ type: "remote_mcp", name: "search" }],
};

const REG_A = { registryId: "reg-a", name: "Registry A", authorizerType: "AWS_IAM", status: "READY" };
const REG_B = { registryId: "reg-b", name: "Registry B", authorizerType: "AWS_IAM", status: "READY" };

type StubRecord = { recordId: string; name: string; status: string; descriptorType?: string; raw?: string };

interface StubOpts {
  registries: object[];
  // Records per registry id; each carries its raw inline content.
  records?: Record<string, StubRecord[]>;
  // Real failure shape seen live (route.ts:17): 500 { error }.
  registriesError?: string;
  // How many records-list calls after a POST still omit the new record
  // (CreateRegistryRecord is async; the real list can lag the 202).
  listLagAfterPost?: number;
}

/**
 * Stubs mirror the real handler response shapes:
 *   GET  /api/agentcore/registry                       -> { registries }     registry/route.ts:14, error 500 { error } :17
 *   GET  /api/agentcore/registry/<id>/records          -> { records }        [registryId]/records/route.ts:31
 *   POST /api/agentcore/registry/<id>/records    (202) -> { recordId, recordArn, status }
 *        records/route.ts:61 returning createRegistryRecord (src/lib/agentcore-sdk.ts:1246)
 *   GET  /api/agentcore/registry/<id>/records/<rid>    -> { record }         [recordId]/route.ts:21
 * POST is stateful: the created record is added to the store, so later lists
 * see it (after `listLagAfterPost` calls), as the real service would.
 */
async function stub(page: Page, opts: StubOpts) {
  const store: Record<string, StubRecord[]> = JSON.parse(JSON.stringify(opts.records ?? {}));
  const posts: Array<{ registryId: string; body: Record<string, unknown> }> = [];
  let lag = 0;
  await page.route(/\/api\/agentcore\/agents\?id=/, (r) =>
    r.fulfill({ json: AGENT })
  );
  // Trace health banner: healthy, so it renders nothing and needs no AWS.
  await page.route(/\/api\/agentcore\/traces\/health/, (r) =>
    r.fulfill({ json: { healthy: true, issues: [] } })
  );
  await page.route(/\/api\/agentcore\/registry(\/.*)?(\?.*)?$/, (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const parts = url.pathname.split("/").filter(Boolean); // api agentcore registry [id] [records] [recordId]
    if (parts.length === 3) {
      if (opts.registriesError) return r.fulfill({ status: 500, json: { error: opts.registriesError } });
      return r.fulfill({ json: { registries: opts.registries } });
    }
    const regId = parts[3];
    const recs = (store[regId] ??= []);
    if (req.method() === "POST" && parts.length === 5) {
      const body = req.postDataJSON();
      posts.push({ registryId: regId, body });
      const recordId = `rec-new-${posts.length}`;
      const inline = body.descriptors?.custom?.inlineContent ?? body.descriptors?.a2a?.agentCard?.inlineContent;
      recs.push({ recordId, name: body.name, status: "CREATING", descriptorType: body.descriptorType, raw: inline });
      lag = opts.listLagAfterPost ?? 0;
      return r.fulfill({
        status: 202,
        json: { recordId, recordArn: `arn:aws:bedrock-agentcore:eu-west-3:000011112222:registry/${regId}/record/${recordId}`, status: "CREATING" },
      });
    }
    if (parts.length === 5) {
      const type = url.searchParams.get("descriptorType");
      let list = recs.filter((x) => !type || (x.descriptorType ?? "CUSTOM") === type);
      if (lag > 0) {
        lag--;
        list = list.filter((x) => !x.recordId.startsWith("rec-new-"));
      }
      return r.fulfill({
        json: { records: list.map(({ raw: _raw, ...rec }) => ({ descriptorType: "CUSTOM", ...rec })) },
      });
    }
    const rec = recs.find((x) => x.recordId === parts[5]);
    if (!rec) return r.fulfill({ status: 500, json: { error: "ResourceNotFoundException" } });
    const type = rec.descriptorType ?? "CUSTOM";
    return r.fulfill({
      json: {
        record: {
          ...rec,
          raw: undefined,
          descriptorType: type,
          descriptors: rec.raw
            ? type === "A2A"
              ? { a2a: { agentCard: { inlineContent: rec.raw } } }
              : { custom: { inlineContent: rec.raw } }
            : undefined,
        },
      },
    });
  });
  return { posts };
}

test.describe("Agent Detail — Register in Registry", () => {
  test("shows Register and opens a pre-filled CUSTOM editor (CUSTOM/A2A only)", async ({ page }) => {
    await stub(page, { registries: [REG_A] });
    await page.goto(`/agents/${AGENT_ID}`);
    const btn = page.getByTestId("register-agent-button");
    await expect(btn).toHaveText(/Register/, { timeout: 15000 });
    await btn.click();

    const modal = page.getByTestId("record-editor-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("record-editor-name")).toHaveValue("fake_agent");
    const type = page.getByTestId("record-editor-type");
    await expect(type).toHaveValue("CUSTOM");
    await expect(type.locator("option")).toHaveCount(2);
    await expect(type.locator("option")).toHaveText(["Custom", "A2A"]);
    await expect(page.getByTestId("record-editor-raw")).toHaveValue(new RegExp(AGENT_ARN.replace(/[/:]/g, "\\$&")));
    // One registry: no picker.
    await expect(page.getByTestId("register-agent-registry")).toHaveCount(0);

    await type.selectOption("A2A");
    await expect(page.getByTestId("record-editor-raw")).toHaveValue(/"protocolVersion": "0\.3\.0"/);
  });

  test("several registries: picker defaults to the first and POSTs to the chosen one", async ({ page }) => {
    await stub(page, { registries: [REG_A, REG_B] });
    await page.goto(`/agents/${AGENT_ID}`);
    await page.getByTestId("register-agent-button").click({ timeout: 15000 });
    const picker = page.getByTestId("register-agent-registry");
    await expect(picker).toHaveValue("reg-a");
    await picker.selectOption("reg-b");

    const post = page.waitForRequest(
      (req) => req.method() === "POST" && req.url().endsWith("/api/agentcore/registry/reg-b/records")
    );
    await page.getByTestId("record-editor-submit").click();
    const body = (await post).postDataJSON();
    expect(body.descriptorType).toBe("CUSTOM");
    expect(body.descriptors.custom.inlineContent).toContain(AGENT_ARN);
  });

  test("shows Registered ✓ linking to the record when a descriptor carries the ARN", async ({ page }) => {
    await stub(page, {
      registries: [REG_A],
      records: {
        "reg-a": [
          {
            recordId: "rec-1",
            // Renamed record: only the ARN can match it.
            name: "renamed-record",
            status: "PENDING_APPROVAL",
            raw: JSON.stringify({ name: "x", description: "", data: { agentArn: AGENT_ARN } }),
          },
        ],
      },
    });
    await page.goto(`/agents/${AGENT_ID}`);
    const link = page.getByTestId("register-agent-registered");
    await expect(link).toContainText("Registered ✓", { timeout: 15000 });
    await expect(link).toHaveAttribute("href", "/registry?registry=reg-a&record=rec-1");
  });

  test("a REJECTED record does not count as registered", async ({ page }) => {
    await stub(page, {
      registries: [REG_A],
      records: { "reg-a": [{ recordId: "rec-1", name: "fake_agent", status: "REJECTED" }] },
    });
    await page.goto(`/agents/${AGENT_ID}`);
    await expect(page.getByTestId("register-agent-button")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("register-agent-registered")).toHaveCount(0);
  });

  test("after a 202 the action shows the submitted record and cannot re-submit until it is listed", async ({ page }) => {
    // The next two detections (CUSTOM + A2A list each) omit the new record (async create); a later poll sees it.
    const { posts } = await stub(page, { registries: [REG_A], listLagAfterPost: 4 });
    await page.goto(`/agents/${AGENT_ID}`);
    await page.getByTestId("register-agent-button").click({ timeout: 15000 });
    await page.getByTestId("record-editor-submit").click();

    const pending = page.getByTestId("register-agent-pending");
    await expect(pending).toContainText("Registration submitted");
    await expect(pending).toHaveAttribute("href", "/registry?registry=reg-a&record=rec-new-1");
    await expect(page.getByTestId("register-agent-button")).toHaveCount(0);

    const registered = page.getByTestId("register-agent-registered");
    await expect(registered).toContainText("Registered ✓", { timeout: 15000 });
    await expect(registered).toHaveAttribute("href", "/registry?registry=reg-a&record=rec-new-1");
    expect(posts).toHaveLength(1);
  });

  test("zero registries: Register is a disabled button, the hint links to the Registry tab", async ({ page }) => {
    await stub(page, { registries: [] });
    await page.goto(`/agents/${AGENT_ID}`);
    const btn = page.getByTestId("register-agent-button");
    await expect(btn).toBeDisabled({ timeout: 15000 });
    await expect(btn).toHaveJSProperty("tagName", "BUTTON");
    await expect(btn).toHaveAttribute("title", /create one in the Registry tab/);
    await expect(page.getByTestId("register-agent-hint")).toHaveAttribute("href", "/registry");
    await btn.click({ force: true });
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_ID}$`));
    await expect(page.getByTestId("record-editor-modal")).toHaveCount(0);
  });

  test("registry list failure (real 500 { error } shape): Register is disabled with the reason", async ({ page }) => {
    await stub(page, { registries: [], registriesError: "not authorized to perform: bedrock-agentcore:ListRegistries" });
    await page.goto(`/agents/${AGENT_ID}`);
    const btn = page.getByTestId("register-agent-button");
    await expect(btn).toBeDisabled({ timeout: 15000 });
    await expect(btn).toHaveAttribute("title", /Registry unavailable: .*ListRegistries/);
  });
});

test.describe("Registry tab — deep link", () => {
  test("/registry?registry=…&record=… selects the registry and opens the record drawer", async ({ page }) => {
    await stub(page, {
      registries: [REG_A, REG_B],
      records: { "reg-b": [{ recordId: "rec-9", name: "deep-linked-record", status: "PENDING_APPROVAL", raw: "{}" }] },
    });
    await page.goto("/registry?registry=reg-b&record=rec-9");
    const drawer = page.getByTestId("record-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText("deep-linked-record");
  });
});
