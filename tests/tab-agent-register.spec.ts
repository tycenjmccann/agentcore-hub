import { test, expect, type Page } from "@playwright/test";

/**
 * TEAM-5452: Agent Detail "Register" / "Registered ✓" (Registry module slot).
 *
 * Hermetic via page.route() — the agent detail and registry routes are stubbed,
 * so no AWS call and no registry write happens here. The live round-trip is a
 * separate, manual verification step (see the PR).
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

interface StubOpts {
  registries: object[];
  // Records per registry id; each carries the raw CUSTOM inline content.
  records?: Record<string, Array<{ recordId: string; name: string; status: string; raw?: string }>>;
}

async function stub(page: Page, opts: StubOpts) {
  await page.route(/\/api\/agentcore\/agents\?id=/, (r) =>
    r.fulfill({ json: AGENT })
  );
  // Trace health banner: healthy, so it renders nothing and needs no AWS.
  await page.route(/\/api\/agentcore\/traces\/health/, (r) =>
    r.fulfill({ json: { healthy: true, issues: [] } })
  );
  await page.route(/\/api\/agentcore\/registry(\/.*)?(\?.*)?$/, (r) => {
    const url = new URL(r.request().url());
    const parts = url.pathname.split("/").filter(Boolean); // api agentcore registry [id] [records] [recordId]
    if (r.request().method() === "POST" && parts.length === 5) {
      return r.fulfill({ status: 202, json: { recordId: "rec-new", recordArn: "x/rec-new", status: "CREATING" } });
    }
    if (parts.length === 3) return r.fulfill({ json: { registries: opts.registries } });
    const regId = parts[3];
    const recs = opts.records?.[regId] ?? [];
    if (parts.length === 5) {
      const type = url.searchParams.get("descriptorType");
      const list = type === "CUSTOM" ? recs : [];
      return r.fulfill({
        json: { records: list.map(({ raw: _raw, ...rec }) => ({ ...rec, descriptorType: "CUSTOM" })) },
      });
    }
    const rec = recs.find((x) => x.recordId === parts[5]);
    return r.fulfill({
      json: {
        record: {
          ...rec,
          descriptorType: "CUSTOM",
          descriptors: rec?.raw ? { custom: { inlineContent: rec.raw } } : undefined,
        },
      },
    });
  });
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
});
