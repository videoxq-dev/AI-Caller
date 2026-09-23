import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Phase 4 browser verification.");

const outputDir = path.join(process.cwd(), "artifacts", "phase4-automation-builder");
await mkdir(outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(pool, query, values, predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await pool.query(query, values);
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function noOverflow(page, label) {
  const result = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(result.scroll - result.client <= 2, `${label} has horizontal overflow.`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
page.on("response", response => {
  if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`);
});

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const stamp = Date.now();
const email = `phase4-builder-${stamp}@example.com`;
const password = "Phase4BrowserPass123!";

try {
  const signUp = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "Phase Four Owner", email, password },
  });
  assert(signUp.ok(), `Owner sign-up failed: ${await signUp.text()}`);

  const owner = await waitFor(
    pool,
    `SELECT u.id AS user_id, m.workspace_id
       FROM "user" u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'
      LIMIT 1`,
    [email],
    rows => rows.rowCount === 1,
    "Phase 4 owner workspace",
  );
  const workspaceId = owner.rows[0].workspace_id;

  await page.goto(`${baseUrl}/automations`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Automations", exact: true }).waitFor();
  await page.getByRole("button", { name: /Create automation/ }).click();
  await page.getByRole("dialog", { name: "Create automation" }).waitFor();
  await page.getByRole("button", { name: /High-value lead alert/ }).click();

  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await page.getByRole("heading", { name: "WHEN", exact: true }).waitFor();
  await page.getByRole("heading", { name: "ONLY IF", exact: true }).waitFor();
  await page.getByRole("heading", { name: "DO", exact: true }).waitFor();
  assert((await page.locator("body").innerText()).includes("Lead becomes qualified"),
    "Builder did not render the business-facing trigger.");
  assert(!(await page.locator("body").innerText()).includes("LEAD_QUALIFIED"),
    "Builder leaked an internal event code.");
  assert(!(await page.locator("body").innerText()).match(/Version\s+\d/i),
    "Builder surfaced workflow versions.");

  const definitionId = page.url().split("/").pop();
  assert(definitionId, "Builder route did not expose a workflow id.");

  const score = page.locator(".conditionRow input[type='number']").first();
  await score.fill("90");

  await page.getByRole("button", { name: "Test automation", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Test automation" });
  await panel.getByLabel("Qualification score").fill("90");
  await panel.getByRole("button", { name: "Run test", exact: true }).click();
  await panel.getByText("Automation would run", { exact: true }).waitFor();
  await panel.getByText(/Qualification score 90 is at least 90/).waitFor();

  await panel.getByLabel("Qualification score").fill("60");
  await panel.getByRole("button", { name: "Run test", exact: true }).click();
  await panel.getByText("Automation would not run", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "×" }).click();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Active", { exact: true }).waitFor({ timeout: 15_000 });

  const persisted = await pool.query(
    `SELECT status, draft FROM workflow_definitions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, definitionId],
  );
  assert(persisted.rows[0]?.status === "PUBLISHED", "Publishing in the Builder did not activate the workflow.");
  assert(persisted.rows[0]?.draft?.conditions?.[0]?.value === 90,
    "Builder condition edit was not saved before publication.");

  const contact = await pool.query(
    `INSERT INTO contacts (workspace_id, name) VALUES ($1, 'Phase Four Lead') RETURNING id`,
    [workspaceId],
  );
  const lead = await pool.query(
    `INSERT INTO leads (workspace_id, contact_id, status, source, qualification_score, qualification_completed_at)
     VALUES ($1, $2, 'QUALIFIED', 'WEBCHAT', 92, now()) RETURNING id`,
    [workspaceId, contact.rows[0].id],
  );
  const event = await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'LEAD_QUALIFIED', 'LEAD', $2, $3::jsonb) RETURNING id`,
    [workspaceId, lead.rows[0].id, JSON.stringify({
      leadId: lead.rows[0].id,
      contactId: contact.rows[0].id,
      qualificationScore: 92,
    })],
  );

  const completed = await waitFor(
    pool,
    `SELECT r.id, r.status,
            count(a.id)::int AS actions,
            count(n.id)::int AS notifications
       FROM automation_runs r
       JOIN workflow_versions v ON v.id = r.workflow_version_id
       LEFT JOIN workflow_action_runs a ON a.automation_run_id = r.id
       LEFT JOIN notifications n ON n.workspace_id = r.workspace_id
         AND n.metadata->>'workflowActionRunId' = a.id::text
      WHERE r.workspace_id = $1 AND r.event_id = $2 AND v.definition_id = $3
      GROUP BY r.id`,
    [workspaceId, event.rows[0].id, definitionId],
    rows => rows.rows[0]?.status === "COMPLETED"
      && rows.rows[0]?.actions === 1
      && rows.rows[0]?.notifications === 1,
    "one custom workflow run and notification",
  );
  assert(completed.rowCount === 1, "One matching event did not produce exactly one custom run.");

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByText("Completed", { exact: true }).first().waitFor({ timeout: 10_000 });
  await page.getByText("Notify", { exact: true }).first().waitFor();
  await noOverflow(page, "Phase 4 activity desktop");

  await page.getByRole("button", { name: "Builder", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByText("Paused", { exact: true }).waitFor();

  // A paused automation can be edited and saved without reactivating.
  await page.locator(".conditionRow input[type='number']").first().fill("95");
  const pausedSaveResponse = page.waitForResponse(response =>
    response.url().endsWith(`/api/automations/workflows/${definitionId}`)
      && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const savedWhilePaused = await pausedSaveResponse;
  assert(savedWhilePaused.ok(), `Saving paused automation failed: ${await savedWhilePaused.text()}`);
  const pausedDraft = await pool.query(
    `SELECT status, draft FROM workflow_definitions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, definitionId],
  );
  assert(pausedDraft.rows[0]?.status === "PAUSED", "Saving a paused automation unexpectedly resumed it.");
  assert(pausedDraft.rows[0]?.draft?.conditions?.[0]?.value === 95,
    "Paused automation edit was not saved.");

  const pausedContact = await pool.query(
    `INSERT INTO contacts (workspace_id, name) VALUES ($1, 'Paused Phase Four Lead') RETURNING id`,
    [workspaceId],
  );
  const pausedLead = await pool.query(
    `INSERT INTO leads (workspace_id, contact_id, status, source, qualification_score, qualification_completed_at)
     VALUES ($1, $2, 'QUALIFIED', 'WEBCHAT', 99, now()) RETURNING id`,
    [workspaceId, pausedContact.rows[0].id],
  );
  const pausedEvent = await pool.query(
    `INSERT INTO automation_events (workspace_id, type, aggregate_type, aggregate_id, payload)
     VALUES ($1, 'LEAD_QUALIFIED', 'LEAD', $2, $3::jsonb) RETURNING id`,
    [workspaceId, pausedLead.rows[0].id, JSON.stringify({
      leadId: pausedLead.rows[0].id,
      contactId: pausedContact.rows[0].id,
      qualificationScore: 99,
    })],
  );
  await waitFor(
    pool,
    `SELECT dispatched_at FROM automation_events WHERE id = $1`,
    [pausedEvent.rows[0].id],
    rows => Boolean(rows.rows[0]?.dispatched_at),
    "paused event dispatcher pass",
  );
  let pausedRuns = await pool.query(
    `SELECT count(*)::int AS count FROM automation_runs WHERE workspace_id = $1 AND event_id = $2`,
    [workspaceId, pausedEvent.rows[0].id],
  );
  assert(pausedRuns.rows[0].count === 0, "Paused automation created a workflow run.");

  await page.getByRole("button", { name: "Resume", exact: true }).first().click();
  await page.getByText("Active", { exact: true }).waitFor();
  const resumedDefinition = await pool.query(
    `SELECT d.status, v.snapshot
       FROM workflow_definitions d
       JOIN workflow_versions v
         ON v.workspace_id = d.workspace_id
        AND v.definition_id = d.id
        AND v.version = d.published_version
      WHERE d.workspace_id = $1 AND d.id = $2`,
    [workspaceId, definitionId],
  );
  assert(resumedDefinition.rows[0]?.status === "PUBLISHED",
    "Resume did not reactivate the paused automation.");
  assert(resumedDefinition.rows[0]?.snapshot?.conditions?.[0]?.value === 95,
    "Resume did not activate the latest saved configuration.");
  await page.waitForTimeout(700);
  pausedRuns = await pool.query(
    `SELECT count(*)::int AS count FROM automation_runs WHERE workspace_id = $1 AND event_id = $2`,
    [workspaceId, pausedEvent.rows[0].id],
  );
  assert(pausedRuns.rows[0].count === 0, "Resume replayed an event that occurred while paused.");

  await noOverflow(page, "Phase 4 builder desktop");
  await page.screenshot({ path: path.join(outputDir, "builder-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "WHEN", exact: true }).waitFor();
  await noOverflow(page, "Phase 4 builder mobile");
  const mobileControls = await page.evaluate(() => {
    const nav = document.querySelector(".appSidebar");
    const footer = document.querySelector(".builderFooter");
    const test = footer?.querySelector("button");
    const save = [...(footer?.querySelectorAll("button") ?? [])]
      .find(button => button.textContent?.trim() === "Save draft");
    return {
      navTop: nav?.getBoundingClientRect().top ?? null,
      footerBottom: footer?.getBoundingClientRect().bottom ?? null,
      test: test?.getBoundingClientRect() ?? null,
      save: save?.getBoundingClientRect() ?? null,
      viewport: window.innerHeight,
    };
  });
  assert(mobileControls.navTop !== null && mobileControls.footerBottom !== null,
    "Mobile navigation or Builder action bar is missing.");
  assert(mobileControls.footerBottom <= mobileControls.navTop + 2,
    "Builder action bar overlaps the mobile navigation.");
  assert(mobileControls.test && mobileControls.test.top >= 0
    && mobileControls.test.bottom <= mobileControls.viewport,
    "Test automation is not visible on mobile.");
  assert(mobileControls.save && mobileControls.save.top >= 0
    && mobileControls.save.bottom <= mobileControls.viewport,
    "Save draft is not visible on mobile.");
  await page.getByRole("button", { name: "Test automation", exact: true }).click();
  await page.getByRole("complementary", { name: "Test automation" }).waitFor();
  await page.getByRole("complementary", { name: "Test automation" })
    .getByRole("button", { name: "×" }).click();
  await page.screenshot({ path: path.join(outputDir, "builder-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/automations`, { waitUntil: "networkidle" });
  await page.getByText("High-value lead alert", { exact: true }).last().waitFor();
  await page.getByText("1 run", { exact: true }).waitFor();

  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log("Phase 4 automation builder acceptance passed: create, test, publish, execute once, audit, pause/resume, and responsive builder UI.");
} finally {
  await pool.end();
  await context.close();
  await browser.close();
}
