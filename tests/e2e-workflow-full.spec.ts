import { test, expect } from "@playwright/test";
import { WORKFLOW_DEFS, getPhaseOrder } from "../src/lib/workflow/workflow-defs";

/**
 * Full end-to-end workflow test against the DEPLOYED site — for EVERY workflow def.
 *
 * The /workflow empty-state has a def selector + "Test Workflow" button. Picking a
 * def and clicking the button POSTs to /api/workflow/start with that workflowDefId
 * and a generic connectivity-check description: the intake agent reads its own
 * `## Available Agents` roster, fans out one tiny ticket per downstream agent, each
 * agent loads its skill + touches one tool + reports completion. No real work, no
 * code written. Same lightweight flow works for any workflow shape.
 *
 * One test is generated per workflow def. Each polls the state API until the
 * pipeline reaches "complete", validating against that def's own phase order.
 *
 * Triggers REAL agent execution — slow (several minutes each).
 * Run with: npx playwright test tests/e2e-workflow-full.spec.ts --timeout 600000
 */
test.describe("End-to-End Workflow (all defs)", () => {
  test.setTimeout(600_000); // 10 minutes per def

  for (const def of WORKFLOW_DEFS) {
    const phaseOrder = getPhaseOrder(def); // ["intake", ...phases, "complete"]

    test(`[${def.id}] run Test Workflow and verify pipeline reaches complete`, async ({ page, request }) => {
      // 1. Fresh load shows the empty-state panel with the def selector + button.
      await page.goto("/workflow");

      // 2. Select this workflow def, then click Test Workflow. handleTestWorkflow
      //    POSTs to /api/workflow/start with workflowDefId and pushState's ?id=.
      await page.getByLabel("Workflow to test").selectOption(def.id);
      const testBtn = page.getByRole("button", { name: "Test Workflow" });
      await expect(testBtn).toBeVisible({ timeout: 10_000 });
      await testBtn.click();
      await page.screenshot({ path: `test-results/workflow-${def.id}-01-clicked.png` });

      // 3. Extract the workflow ID from the URL.
      let workflowId: string | null = null;
      await expect
        .poll(async () => {
          const m = page.url().match(/[?&]id=([^&]+)/);
          workflowId = m ? m[1] : null;
          return workflowId;
        }, { timeout: 30_000, message: "Test Workflow did not produce a workflow id in the URL" })
        .toBeTruthy();

      // Fallback: most recent workflow if pushState didn't land.
      if (!workflowId) {
        const listRes = await request.get("/api/workflow/list");
        if (listRes.ok()) {
          const data = await listRes.json();
          if (data.workflows?.length > 0) workflowId = data.workflows[0].id;
        }
      }

      console.log(`[${def.id}] Workflow ID: ${workflowId}`);
      expect(workflowId).toBeTruthy();

      // 4. Poll the state API for real phase progression against THIS def's order.
      let lastPhase = "";
      let ticketsDone = 0;
      let totalTickets = 0;
      let reachedComplete = false;

      for (let i = 0; i < 120; i++) { // 120 * 5s = 10 minutes max
        await new Promise((r) => setTimeout(r, 5000));

        const stateRes = await request.get(`/api/workflow/${workflowId}/state`);
        if (!stateRes.ok()) {
          console.log(`[${def.id}] State API returned ${stateRes.status()} — retrying...`);
          continue;
        }

        const state = await stateRes.json();
        const currentPhase = state.phase || "";
        const tasksRaw = state.agentTasks || state.tickets || {};
        const tasks = Array.isArray(tasksRaw) ? tasksRaw : Object.values(tasksRaw) as { status?: string }[];
        totalTickets = tasks.length;
        ticketsDone = tasks.filter((t: { status?: string }) =>
          t.status === "done" || t.status === "Done" || t.status === "closed" || t.status === "complete"
        ).length;

        if (currentPhase !== lastPhase) {
          console.log(`[${def.id}] Phase: ${lastPhase || "(start)"} → ${currentPhase} (${ticketsDone}/${totalTickets} done, ${i * 5}s)`);
          lastPhase = currentPhase;
          await page.reload();
          await page.waitForTimeout(2000);
          await page.screenshot({ path: `test-results/workflow-${def.id}-phase-${currentPhase}.png` });
        }

        if (i % 12 === 0 && i > 0) {
          console.log(`[${def.id}]   ... still in "${currentPhase}" (${ticketsDone}/${totalTickets}, ${i * 5}s)`);
        }

        if (currentPhase === "complete" || currentPhase === "completed") {
          reachedComplete = true;
          console.log(`[${def.id}] COMPLETE after ${i * 5}s — ${ticketsDone}/${totalTickets} tickets done`);
          break;
        }
      }

      // 5. Final validation against this def's phase order.
      await page.screenshot({ path: `test-results/workflow-${def.id}-03-final.png` });

      if (!reachedComplete) {
        console.log(`[${def.id}] Did not reach "complete". Last phase: ${lastPhase} (${ticketsDone}/${totalTickets})`);
      }
      const phaseIdx = phaseOrder.indexOf(lastPhase);
      expect(reachedComplete, `[${def.id}] pipeline should reach "complete"; last phase was "${lastPhase}" with ${ticketsDone}/${totalTickets} tickets done`).toBe(true);
      expect(phaseIdx, `[${def.id}] last phase "${lastPhase}" not in def phase order ${JSON.stringify(phaseOrder)}`).toBe(phaseOrder.length - 1);
      expect(ticketsDone).toBe(totalTickets);
    });
  }

  test("verify workflow state API returns data for existing workflows", async ({ request }) => {
    const listRes = await request.get("/api/workflow/list");
    expect(listRes.status()).toBe(200);
    const data = await listRes.json();
    expect(data).toHaveProperty("workflows");
    expect(Array.isArray(data.workflows)).toBeTruthy();

    if (data.workflows.length > 0) {
      const latest = data.workflows[0];
      const stateRes = await request.get(`/api/workflow/${latest.id}/state`);
      expect(stateRes.status()).toBe(200);
      const state = await stateRes.json();
      expect(state).toHaveProperty("phase");
      expect(state).toHaveProperty("agentTasks");
    }
  });
});
