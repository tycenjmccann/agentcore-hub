import { test, expect } from "@playwright/test";

/**
 * Full end-to-end workflow test against the DEPLOYED site.
 *
 * Drives the built-in "Test Workflow" button on /workflow, which fires the same
 * connectivity-check pipeline as scripts/test-ticket-flow.sh: each of the 14
 * agents loads its skill, touches its tools (git ls-remote, a tiny S3 write),
 * and reports completion — no code is written and no repos are cloned. That is
 * the intended e2e path: it exercises real orchestration + every agent's tool
 * access while finishing far faster than a feature build. We then poll the
 * state API until the pipeline reaches "complete".
 *
 * This test triggers REAL agent execution and takes several minutes.
 * Run with: npx playwright test tests/e2e-workflow-full.spec.ts --timeout 600000
 */
test.describe("End-to-End Workflow", () => {
  test.setTimeout(600_000); // 10 minutes

  test("run built-in Test Workflow and verify pipeline reaches complete", async ({ page, request }) => {
    // 1. Navigate to workflow page — fresh load shows the empty-state panel
    //    with the amber "Test Workflow" button (it only renders when no
    //    workflow is selected and the intake form is closed).
    await page.goto("/workflow");

    // 2. Click the built-in Test Workflow button. handleTestWorkflow POSTs to
    //    /api/workflow/start with the connectivity-check description, then
    //    pushState's the new id into the URL as ?id=<workflowId>.
    const testBtn = page.getByRole("button", { name: "Test Workflow" });
    await expect(testBtn).toBeVisible({ timeout: 10_000 });
    await testBtn.click();
    await page.screenshot({ path: "test-results/workflow-01-test-clicked.png" });

    // 3. Extract the workflow ID from the URL once handleTestWorkflow navigates.
    let workflowId: string | null = null;
    await expect
      .poll(async () => {
        const m = page.url().match(/[?&]id=([^&]+)/);
        workflowId = m ? m[1] : null;
        return workflowId;
      }, { timeout: 30_000, message: "Test Workflow did not produce a workflow id in the URL" })
      .toBeTruthy();

    // Fallback: if pushState didn't land, take the most recent workflow.
    if (!workflowId) {
      const listRes = await request.get("/api/workflow/list");
      if (listRes.ok()) {
        const data = await listRes.json();
        if (data.workflows?.length > 0) workflowId = data.workflows[0].id;
      }
    }

    console.log(`Workflow ID: ${workflowId}`);
    expect(workflowId).toBeTruthy();

    // 5. Poll the state API for real phase progression
    const phaseOrder = ["requirements", "design", "development", "qa", "review", "complete"];
    let lastPhase = "";
    let ticketsDone = 0;
    let totalTickets = 0;
    let reachedComplete = false;

    for (let i = 0; i < 120; i++) { // 120 * 5s = 10 minutes max
      await new Promise((r) => setTimeout(r, 5000));

      // Poll state API
      const stateRes = await request.get(`/api/workflow/${workflowId}/state`);
      if (!stateRes.ok()) {
        console.log(`State API returned ${stateRes.status()} — retrying...`);
        continue;
      }

      const state = await stateRes.json();
      const currentPhase = state.phase || "";
      // agentTasks is an object keyed by agent ID, tickets is an array
      const tasksRaw = state.agentTasks || state.tickets || {};
      const tasks = Array.isArray(tasksRaw) ? tasksRaw : Object.values(tasksRaw) as { status?: string }[];
      totalTickets = tasks.length;
      ticketsDone = tasks.filter((t: { status?: string }) =>
        t.status === "done" || t.status === "Done" || t.status === "closed" || t.status === "complete"
      ).length;

      // Log phase transitions
      if (currentPhase !== lastPhase) {
        console.log(`Phase transition: ${lastPhase || "(start)"} → ${currentPhase} (${ticketsDone}/${totalTickets} tickets done, elapsed: ${i * 5}s)`);
        lastPhase = currentPhase;

        // Screenshot on phase change
        await page.reload();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: `test-results/workflow-phase-${currentPhase}.png` });
      }

      // Log progress periodically
      if (i % 12 === 0 && i > 0) {
        console.log(`  ... still in phase "${currentPhase}" (${ticketsDone}/${totalTickets} done, ${i * 5}s elapsed)`);
      }

      // Success: pipeline completed
      if (currentPhase === "complete" || currentPhase === "completed") {
        reachedComplete = true;
        console.log(`Pipeline COMPLETE after ${i * 5}s — ${ticketsDone}/${totalTickets} tickets done`);
        break;
      }
    }

    // 6. Final validation
    await page.screenshot({ path: "test-results/workflow-03-final-state.png" });

    // The connectivity check is designed to finish — each agent does a tiny,
    // bounded task. Hold the full bar: the pipeline must reach "complete".
    const phaseIdx = phaseOrder.indexOf(lastPhase);
    if (!reachedComplete) {
      console.log(`Pipeline did not reach "complete" within timeout. Last phase: ${lastPhase} (${ticketsDone}/${totalTickets} done)`);
    }
    expect(reachedComplete, `pipeline should reach "complete"; last phase was "${lastPhase}" with ${ticketsDone}/${totalTickets} tickets done`).toBe(true);
    expect(phaseIdx).toBe(phaseOrder.length - 1);
    expect(ticketsDone).toBe(totalTickets);
  });

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
