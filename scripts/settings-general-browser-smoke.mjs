import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const stamp = Date.now();
const email = `settings-general-${stamp}@example.com`;
const password = "SettingsGeneral123!";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "Settings Owner", email, password },
  });
  assert(signup.ok(), `Owner signup failed: ${await signup.text()}`);
  const owner = await pool.query(
    `SELECT u.id AS user_id, m.workspace_id FROM "user" u
     JOIN memberships m ON m.user_id = u.id WHERE u.email = $1 AND m.role = 'OWNER'`, [email],
  );
  assert(owner.rowCount === 1, "Owner workspace was not provisioned.");
  const { user_id: ownerId, workspace_id: originalId } = owner.rows[0];
  const setup = await context.request.put(`${baseUrl}/api/business`, {
    data: { businessName: "Real Business", timezone: "UTC", city: "Sheridan", industry: "Commercial cleaning", completeStep: true },
  });
  assert(setup.ok(), `Business setup failed: ${await setup.text()}`);

  await page.goto(`${baseUrl}/settings`);
  const name = page.getByLabel("Business name");
  await name.waitFor();
  await page.waitForFunction(expected => document.querySelector(".settingsFormGrid input")?.value === expected, "Real Business");
  assert(await name.inputValue() === "Real Business", "Settings did not load the stored business name.");
  await pool.query(`UPDATE business_profiles SET city = 'Updated by another administrator' WHERE workspace_id = $1`, [originalId]);
  await name.fill("Renamed Business");
  await page.getByLabel("Timezone").selectOption("America/New_York");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Saved" }).waitFor();
  await page.reload();
  await page.waitForFunction(expected => document.querySelector(".settingsFormGrid input")?.value === expected, "Renamed Business");
  assert(await name.inputValue() === "Renamed Business", "Business name was not retained after refresh.");
  assert(await page.getByLabel("Timezone").inputValue() === "America/New_York", "Timezone was not retained after refresh.");
  const preserved = await pool.query(
    `SELECT business_name, timezone, city, industry FROM business_profiles WHERE workspace_id = $1`, [originalId],
  );
  assert(preserved.rows[0]?.city === "Updated by another administrator" && preserved.rows[0]?.industry === "Commercial cleaning",
    "Settings update erased another administrator's newer business setup fields.");
  const progress = await pool.query(`SELECT business_completed_at FROM setup_progress WHERE workspace_id = $1`, [originalId]);
  assert(progress.rows[0]?.business_completed_at, "Settings update erased onboarding completion.");

  const [other] = (await pool.query(`INSERT INTO workspaces (name) VALUES ('Second Workspace') RETURNING id`)).rows;
  await pool.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')`, [other.id, ownerId]);
  const switched = await context.request.post(`${baseUrl}/api/workspaces`, { data: { workspaceId: other.id } });
  assert(switched.ok(), `Workspace switch failed: ${await switched.text()}`);
  await page.goto(`${baseUrl}/settings`);
  await page.waitForFunction(expected => document.querySelector(".settingsFormGrid input")?.value === expected, "Second Workspace");
  assert(await name.inputValue() === "Second Workspace", "Settings showed another workspace's business name.");
  await page.getByRole("button", { name: "Other channels" }).click();
  assert(await page.getByRole("button", { name: "Save changes" }).count() === 0,
    "Channels page claims a Save changes operation without editable settings.");

  await pool.query(
    `INSERT INTO workspace_plans (workspace_id, plan_id, source)
     VALUES ($1, 'GROWTH', 'E2E') ON CONFLICT (workspace_id) DO UPDATE SET plan_id = 'GROWTH', source = 'E2E'`, [originalId],
  );
  const staffContext = await browser.newContext();
  try {
    const staffEmail = `settings-staff-${stamp}@example.com`;
    const staffSignup = await staffContext.request.post(`${baseUrl}/api/auth/sign-up/email`, {
      data: { name: "Settings Staff", email: staffEmail, password },
    });
    assert(staffSignup.ok(), `Staff signup failed: ${await staffSignup.text()}`);
    const staff = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [staffEmail]);
    await pool.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'STAFF')`,
      [originalId, staff.rows[0].id]);
    const staffSwitch = await staffContext.request.post(`${baseUrl}/api/workspaces`, { data: { workspaceId: originalId } });
    assert(staffSwitch.ok(), `Staff workspace switch failed: ${await staffSwitch.text()}`);
    const denied = await staffContext.request.put(`${baseUrl}/api/business`, {
      data: { businessName: "Unauthorized Change", timezone: "UTC" },
    });
    assert(denied.status() === 403, `Staff direct business mutation was not denied: ${await denied.text()}`);
    const deniedGeneral = await staffContext.request.patch(`${baseUrl}/api/business`, {
      data: { businessName: "Unauthorized Change", timezone: "UTC" },
    });
    assert(deniedGeneral.status() === 403, "Staff direct General Settings mutation was not denied.");
    const deniedHours = await staffContext.request.put(`${baseUrl}/api/business/hours`, {
      data: { hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, enabled: false })) },
    });
    assert(deniedHours.status() === 403, "Staff direct business-hours mutation was not denied.");
    const staffPage = await staffContext.newPage();
    await staffPage.goto(`${baseUrl}/settings`);
    await staffPage.waitForFunction(expected => document.querySelector(".settingsFormGrid input")?.value === expected, "Renamed Business");
    assert(await staffPage.getByLabel("Business name").isDisabled(), "Staff could edit business fields in the UI.");
    assert(await staffPage.getByRole("button", { name: "Save changes" }).count() === 0,
      "Staff saw a business settings save control.");
  } finally {
    await staffContext.close();
  }

  console.log("General Settings browser regression passed: persisted real fields, workspace isolation, false-save removal, staff UI and API denial.");
} finally {
  await browser.close();
  await pool.end();
}
