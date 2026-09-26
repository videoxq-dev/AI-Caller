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
const email = `onboarding-return-${stamp}@example.com`;
const password = "OnboardingReturn123!";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectPath(pathname, message) {
  await page.waitForURL(url => new URL(url).pathname === pathname);
  assert(new URL(page.url()).pathname === pathname, message);
}

try {
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "Onboarding Return Owner", email, password },
  });
  assert(signup.ok(), `New account signup failed: ${await signup.text()}`);
  const owner = await pool.query(
    `SELECT u.id AS user_id, m.workspace_id FROM "user" u
       JOIN memberships m ON m.user_id = u.id WHERE u.email = $1 AND m.role = 'OWNER'`,
    [email],
  );
  assert(owner.rowCount === 1, "New account has no owner workspace.");
  const { user_id: userId, workspace_id: workspaceId } = owner.rows[0];

  await page.goto(`${baseUrl}/welcome`);
  await expectPath("/welcome", "New account skipped onboarding.");
  await page.getByRole("link", { name: /Start Setup/ }).waitFor();

  await pool.query(
    `INSERT INTO setup_progress (workspace_id, business_completed_at)
     VALUES ($1, now())`,
    [workspaceId],
  );
  await page.reload();
  await expectPath("/welcome", "Incomplete account skipped onboarding.");
  assert((await page.getByRole("link", { name: /Continue Setup/ }).getAttribute("href")) === "/setup/ai",
    "Interrupted onboarding did not resume at the first incomplete step.");

  await pool.query(
    `UPDATE setup_progress SET live_completed_at = now() WHERE workspace_id = $1`,
    [workspaceId],
  );
  await page.goto(`${baseUrl}/welcome`);
  await expectPath("/dashboard", "Completed account was routed back into onboarding.");
  await page.reload();
  await expectPath("/dashboard", "Refreshing an authenticated route restarted onboarding.");

  const signout = await context.request.post(`${baseUrl}/api/auth/sign-out`, { data: {} });
  assert(signout.ok(), `Sign out failed: ${await signout.text()}`);
  await page.goto(`${baseUrl}/sign-in?returnTo=%2Fwelcome`);
  await page.getByLabel("Email address").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expectPath("/dashboard", "Returning account's login reopened onboarding.");

  const [partialWorkspace] = (await pool.query(
    `INSERT INTO workspaces (name) VALUES ('Incomplete Second Workspace') RETURNING id`,
  )).rows;
  await pool.query(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
    [partialWorkspace.id, userId],
  );
  const switchToPartial = await context.request.post(`${baseUrl}/api/workspaces`, {
    data: { workspaceId: partialWorkspace.id },
  });
  assert(switchToPartial.ok(), `Workspace switch failed: ${await switchToPartial.text()}`);
  await page.goto(`${baseUrl}/welcome`);
  await expectPath("/welcome", "Another workspace's completion hid this workspace's onboarding.");
  const switchBack = await context.request.post(`${baseUrl}/api/workspaces`, {
    data: { workspaceId },
  });
  assert(switchBack.ok(), `Return workspace switch failed: ${await switchBack.text()}`);
  await page.goto(`${baseUrl}/welcome`);
  await expectPath("/dashboard", "Completion was not restored when switching back.");

  console.log("Onboarding return browser regression passed: new, partial, completed, refresh, sign out/login and switched workspace.");
} finally {
  await browser.close();
  await pool.end();
}
