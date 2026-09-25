import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const { Pool } = pg;
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const outputDir = path.join(process.cwd(), "artifacts", "agency-workspaces");
await mkdir(outputDir, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
let clientContext;
const page = await context.newPage();
const failures = [];
page.on("pageerror", error => failures.push(`pageerror: ${error.message}`));
page.on("response", response => {
  if (response.status() >= 500) failures.push(`HTTP ${response.status()} ${response.url()}`);
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function noOverflow(label) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(size.scrollWidth - size.width <= 2, `${label} has horizontal overflow: ${JSON.stringify(size)}`);
}

const stamp = Date.now();
const email = `agency-browser-${stamp}@example.com`;
const password = "AgencyBrowserPass123!";
const clientEmail = `agency-client-${stamp}@example.com`;
const clientPassword = "AgencyClientPass123!";

async function grant(userId, workspaceId, productCode) {
  await pool.query(
    `INSERT INTO licenses (workspace_id, purchaser_user_id, source, external_purchase_id, product_code, status, purchased_at)
     VALUES ($1, $2, 'MANUAL', $3, $4, 'ACTIVE', now())`,
    [workspaceId, userId, `agency-browser-${productCode}-${stamp}`, productCode],
  );
}

try {
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "Agency Browser Owner", email, password },
  });
  assert(signup.ok(), `Signup failed: ${await signup.text()}`);
  const owner = await pool.query(
    `SELECT u.id AS user_id, m.workspace_id FROM "user" u
      JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.role = 'OWNER'`,
    [email],
  );
  assert(owner.rowCount === 1, "Expected one original owner workspace.");
  const { user_id: userId, workspace_id: originalId } = owner.rows[0];

  let inventory = await context.request.get(`${baseUrl}/api/agency/workspaces`);
  assert(inventory.status() === 403, "A Core buyer accessed the Agency inventory.");
  await page.goto(`${baseUrl}/workspaces`);
  assert(await page.getByRole("heading", { name: "Workspaces" }).count() === 0,
    "Core buyer accessed the Agency page.");

  await grant(userId, originalId, "UNLIMITED");
  await page.goto(`${baseUrl}/dashboard`);
  assert(await page.getByRole("link", { name: "Workspaces" }).count() === 0,
    "Unlimited buyer saw Agency navigation.");
  const created = await context.request.put(`${baseUrl}/api/workspaces`, {
    data: { name: "Unlimited Second Business" },
  });
  assert(created.status() === 201, `Unlimited second workspace failed: ${await created.text()}`);
  const secondId = (await created.json()).workspace.workspaceId;
  assert((await context.request.put(`${baseUrl}/api/workspaces`, {
    data: { name: "Not Included Third Business" },
  })).status() === 403, "Unlimited created more than two total workspaces.");

  await grant(userId, originalId, "AGENCY_50");
  await page.goto(`${baseUrl}/workspaces`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Workspaces", exact: true }).waitFor();
  await page.getByText("1 / 50").waitFor();
  assert(await page.getByText("Original business", { exact: true }).count() === 1,
    "Agency dashboard did not identify the separately included original business.");
  assert(await page.getByRole("combobox", { name: "Active workspace" }).count() === 1,
    "Agency dashboard lost the existing quick switcher.");
  const allowed = await context.request.get(`${baseUrl}/api/agency/workspaces`);
  assert(allowed.status() === 200, `Agency inventory failed: ${await allowed.text()}`);
  const data = await allowed.json();
  assert(data.capacity.agencyClientLimit === 50 && data.capacity.agencyClientsUsed === 1
    && data.capacity.businessLimit === 51, "Agency 50 quota wrongly counts original business.");
  assert(data.workspaces.length === 2, "Agency inventory omitted a purchased workspace.");

  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByLabel("Business name").fill("Agency Second Client");
  await page.locator(".agencyCreateCard").getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.waitForURL(url => new URL(url).pathname === "/setup/business");
  await page.goto(`${baseUrl}/workspaces`, { waitUntil: "networkidle" });
  await page.getByText("2 / 50").waitFor();
  assert(await page.getByText("Agency Second Client").count() >= 1, "New client is missing from dashboard.");
  assert(await page.getByText("3 total").count() === 1, "Original business not counted in total.");

  const agencyInventory = await (await context.request.get(`${baseUrl}/api/agency/workspaces`)).json();
  const clientWorkspace = agencyInventory.workspaces.find((workspace) => workspace.workspaceName === "Agency Second Client");
  assert(clientWorkspace, "Could not resolve the newly created Agency client workspace.");

  const clientRow = page.locator(".agencyWorkspaceRow").filter({ hasText: "Agency Second Client" });
  await clientRow.getByRole("button", { name: "Manage access" }).click();
  await page.getByRole("heading", { name: "Agency Second Client", exact: true }).last().waitFor();
  await page.getByText("0 / 5", { exact: true }).waitFor();
  await page.getByLabel("Invite someone").fill(clientEmail);
  await page.getByRole("combobox", { name: "Access role" }).selectOption("CLIENT_OWNER");
  const inviteResponsePromise = page.waitForResponse(response =>
    response.url().endsWith(`/api/agency/workspaces/${clientWorkspace.workspaceId}/access/invitations`)
      && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send invite" }).click();
  const inviteResponse = await inviteResponsePromise;
  if (inviteResponse.status() !== 201) throw new Error(`Client-owner invitation failed: ${await inviteResponse.text()}`);
  const invitePayload = await inviteResponse.json();
  assert(invitePayload.e2eToken, "Agency E2E client-owner invitation did not expose its guarded token.");
  await page.getByText("Client owner", { exact: true }).last().waitFor();

  clientContext = await browser.newContext();
  const clientSignup = await clientContext.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "Agency Client Owner", email: clientEmail, password: clientPassword },
  });
  assert(clientSignup.ok(), `Client signup failed: ${await clientSignup.text()}`);
  const accepted = await clientContext.request.post(`${baseUrl}/api/team/invitations/accept`, {
    data: { token: invitePayload.e2eToken },
  });
  if (!accepted.ok()) throw new Error(`Client-owner invitation acceptance failed: ${await accepted.text()}`);
  const acceptedPayload = await accepted.json();
  assert(acceptedPayload.membership.workspaceId === clientWorkspace.workspaceId
    && acceptedPayload.membership.role === "OWNER",
    "Client was not granted operational OWNER access to the intended workspace.");

  const clientWorkspaces = await clientContext.request.get(`${baseUrl}/api/workspaces`);
  if (!clientWorkspaces.ok()) throw new Error(`Client workspace list failed: ${await clientWorkspaces.text()}`);
  const clientWorkspaceData = await clientWorkspaces.json();
  assert(clientWorkspaceData.workspaces.some((workspace) =>
    workspace.workspaceId === clientWorkspace.workspaceId && workspace.role === "OWNER"),
    "Client owner cannot see their assigned workspace.");
  assert(!clientWorkspaceData.workspaces.some((workspace) => workspace.workspaceId === originalId),
    "Client owner gained sibling/original Agency workspace membership.");

  const siblingSwitch = await clientContext.request.post(`${baseUrl}/api/workspaces`, {
    data: { workspaceId: originalId },
  });
  assert(siblingSwitch.status() === 404, "Client owner was able to switch into the Agency original workspace.");
  assert((await clientContext.request.get(`${baseUrl}/api/agency/workspaces`)).status() === 403,
    "Client owner gained Agency commercial dashboard access.");

  const ownership = await pool.query(
    `SELECT purchaser_user_id FROM workspace_commercial_owners WHERE workspace_id = $1`,
    [clientWorkspace.workspaceId],
  );
  assert(ownership.rows[0]?.purchaser_user_id === userId,
    "Delegating client OWNER access changed the workspace commercial owner.");

  await page.getByRole("button", { name: "Close" }).click();

  // An Agency client is a read-only credit user, even with operational OWNER.
  // Seed a commercial-owner-funded checkout so the price-isolation assertion
  // would catch a regression that accidentally exposes paid/pending top-ups.
  await pool.query(
    `INSERT INTO credit_topups
       (workspace_id, created_by_user_id, pack_code, credits, amount_cents, currency, status)
     VALUES ($1, $2, 'CREDITS_10000', 10000, 1000, 'usd', 'CHECKOUT_CREATED')`,
    [clientWorkspace.workspaceId, userId],
  );
  const clientBillingBefore = await clientContext.request.get(`${baseUrl}/api/billing`);
  assert(clientBillingBefore.ok(), "Delegated client could not view their workspace billing.");
  const clientBillingData = await clientBillingBefore.json();
  assert(clientBillingData.canPurchaseCredits === false && clientBillingData.packs.length === 0,
    "Agency client was offered direct platform credit purchases.");
  assert(clientBillingData.topups.length === 0,
    "Agency client could inspect the Agency's private credit purchase prices.");
  assert(clientBillingData.balance === 0, "New Agency client unexpectedly received credits.");
  const deniedTopup = await clientContext.request.post(`${baseUrl}/api/billing/checkout`, {
    data: { packCode: "CREDITS_10000" },
  });
  assert(deniedTopup.status() === 403, "Client-owner account could purchase credits directly.");
  assert((await clientContext.request.get(`${baseUrl}/api/agency/credits`)).status() === 403,
    "Client account gained access to the Agency credit pool.");
  const deniedAllocation = await clientContext.request.post(`${baseUrl}/api/agency/credits/allocations`, {
    data: { workspaceId: clientWorkspace.workspaceId, amount: 1, idempotencyKey: crypto.randomUUID() },
  });
  assert(deniedAllocation.status() === 403, "Client account allocated Agency-owned credits.");

  // Provider-paid pool purchases are covered by the Stripe integration tests.
  // Seed an isolated Agency pool here to verify the real browser allocation UI.
  await pool.query(`INSERT INTO agency_credit_pools (purchaser_user_id, balance)
    VALUES ($1, 10000) ON CONFLICT (purchaser_user_id) DO UPDATE SET balance = 10000`, [userId]);
  await page.getByRole("button", { name: "Refresh balance" }).click();
  const poolCard = page.getByRole("region", { name: "Agency credit pool" });
  await poolCard.getByText("10,000", { exact: true }).waitFor();
  await page.getByLabel("Client workspace", { exact: true }).selectOption(clientWorkspace.workspaceId);
  await page.getByLabel("Credits", { exact: true }).fill("2000");
  const allocationPromise = page.waitForResponse((response) => response.url().endsWith(
    "/api/agency/credits/allocations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Allocate credits" }).click();
  const allocationResponse = await allocationPromise;
  if (allocationResponse.status() !== 201) throw new Error(`Agency allocation failed: ${await allocationResponse.text()}`);
  await poolCard.getByText("8,000", { exact: true }).first().waitFor();
  const clientBillingAfter = await clientContext.request.get(`${baseUrl}/api/billing`);
  assert(clientBillingAfter.ok(), "Client billing was not readable after Agency allocation.");
  const clientAfter = await clientBillingAfter.json();
  assert(clientAfter.balance === 2000 && clientAfter.canPurchaseCredits === false,
    "Agency allocation did not fund the client wallet without enabling direct checkout.");
  assert(clientAfter.ledger.some((entry) => entry.referenceType === "AGENCY_ALLOCATION" ||
    (entry.reason === "Credits allocated by Agency" && entry.amount === 2000)),
    "Client billing activity omitted the Agency credit allocation.");
  const agencyOriginalCredits = await context.request.get(`${baseUrl}/api/credits`);
  assert(agencyOriginalCredits.ok(), "Original Agency wallet was not readable.");
  // The original workspace is not the source of Agency allocations.
  const originalWallet = await pool.query(`SELECT balance FROM credit_wallets WHERE workspace_id = $1`, [originalId]);
  assert((originalWallet.rows[0]?.balance ?? 0) === 0, "Agency allocation consumed original workspace credits.");

  await noOverflow("Agency desktop");
  await page.screenshot({ path: path.join(outputDir, "agency-desktop.png"), fullPage: true });

  // All owned workspaces remain selectable from the original quick switcher.
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.getByRole("combobox", { name: "Active workspace" }).selectOption(originalId),
  ]);
  await page.getByText("2 / 50").waitFor();
  const switchResult = await context.request.post(`${baseUrl}/api/workspaces`, {
    data: { workspaceId: secondId },
  });
  assert(switchResult.ok(), "Existing quick-switch API failed for an Agency client.");
  await page.goto(`${baseUrl}/workspaces`, { waitUntil: "networkidle" });
  assert(await page.getByRole("combobox", { name: "Active workspace" }).inputValue() === secondId,
    "Quick switcher did not reflect the selected client.");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("2 / 50").waitFor();
  await noOverflow("Agency mobile");
  await page.screenshot({ path: path.join(outputDir, "agency-mobile.png"), fullPage: true });

  await grant(userId, originalId, "AGENCY_100");
  await page.goto(`${baseUrl}/workspaces`, { waitUntil: "networkidle" });
  await page.getByText("2 / 150").waitFor();
  const higher = await (await context.request.get(`${baseUrl}/api/agency/workspaces`)).json();
  assert(higher.capacity.businessLimit === 151 && higher.capacity.agencyClientsAvailable === 148,
    "Agency 50 + 100 purchases did not stack to 150 client slots.");

  // D2: only the Agency purchaser can clone a reviewed Core template; retry
  // must not use an additional stacked client slot or copy financial state.
  const reviewedTemplate = await context.request.post(`${baseUrl}/api/agency/templates`, {
    data: {
      name: "Cleaning Receptionist", reviewed: true,
      snapshot: {
        schemaVersion: 1,
        business: { industry: "Cleaning", summary: "Welcome to {{business_name}}", timezone: "UTC", hours: [] },
        agent: {
          name: "Mia", tone: "Helpful", primaryGoal: "Answer cleaning inquiries", whenUnsure: "Escalate to a human",
          openingMessage: "Hello from {{business_name}}", guardrails: [],
          voice: { profileKey: "ava-us-1", language: "en-US", speakingRate: 1,
            recordingPolicy: "ANNOUNCE", afterHoursEnabled: true },
          qualification: { enabled: false, criteria: [] },
        },
        services: [{ name: "Office cleaning", description: "Commercial cleaning", priceText: "$99", active: true }],
        faqs: [], policies: [], recipes: [],
      },
    },
  });
  if (!reviewedTemplate.ok()) throw new Error(`Template creation failed: ${await reviewedTemplate.text()}`);
  const templateId = (await reviewedTemplate.json()).template.id;
  const cloneInput = { name: "Agency Templated Client", templateId, version: 1, idempotencyKey: crypto.randomUUID() };
  const cloned = await context.request.post(`${baseUrl}/api/agency/workspaces/from-template`, { data: cloneInput });
  if (cloned.status() !== 201) throw new Error(`Template-based client creation failed: ${await cloned.text()}`);
  const cloneId = (await cloned.json()).workspace.workspaceId;
  const retry = await context.request.post(`${baseUrl}/api/agency/workspaces/from-template`, { data: cloneInput });
  if (!retry.ok()) throw new Error(`Template clone retry failed: ${await retry.text()}`);
  assert((await retry.json()).workspace.workspaceId === cloneId, "Template creation retry duplicated a client.");
  const cloneData = await pool.query(`SELECT a.status AS agent_status, a.opening_message,
    p.business_name, p.phone, p.website_url, w.balance,
    x.template_version FROM ai_agents a
    JOIN business_profiles p ON p.workspace_id = a.workspace_id
    JOIN credit_wallets w ON w.workspace_id = a.workspace_id
    JOIN agency_workspace_template_applications x ON x.workspace_id = a.workspace_id
    WHERE a.workspace_id = $1`, [cloneId]);
  assert(cloneData.rows[0]?.agent_status === "DRAFT"
    && cloneData.rows[0]?.opening_message === "Hello from Agency Templated Client"
    && cloneData.rows[0]?.business_name === "Agency Templated Client"
    && cloneData.rows[0]?.phone === null && cloneData.rows[0]?.website_url === null
    && cloneData.rows[0]?.balance === 0 && cloneData.rows[0]?.template_version === 1,
  "Templated client did not receive safe, isolated, draft-only Core setup.");
  const clientCloneDenied = await clientContext.request.post(`${baseUrl}/api/agency/workspaces/from-template`,
    { data: { ...cloneInput, idempotencyKey: crypto.randomUUID() } });
  assert(clientCloneDenied.status() === 404 || clientCloneDenied.status() === 403,
    "Delegated client could use the Agency template to create a sibling workspace.");

  const afterClone = await (await context.request.get(`${baseUrl}/api/agency/workspaces`)).json();
  assert(afterClone.capacity.agencyClientsUsed === 3 && afterClone.capacity.agencyClientLimit === 150,
    "Template creation did not use exactly one stacked Agency client slot.");
  // D3: Agency extracts, edits, explicitly reviews and publishes the source
  // setup through the actual UI, then creates another independent client.
  await page.goto(`${baseUrl}/workspaces/templates`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Reusable client setups" }).waitFor();
  await page.getByLabel("Source business").selectOption(cloneId);
  await page.getByRole("button", { name: "Review reusable setup" }).click();
  await page.getByRole("heading", { name: "Prepare template" }).waitFor();
  await page.getByLabel("Template name").fill("Agency Cleaning Reusable");
  await page.getByLabel("Business summary").fill("Reusable commercial cleaning assistance");
  await page.getByLabel("Opening greeting").fill("Hello from {{business_name}}!");
  await page.getByRole("checkbox", { name: /reviewed this template/i }).check();
  await page.getByRole("button", { name: "Publish template" }).click();
  await page.getByText("Template created.").waitFor();
  const savedTemplateRow = page.locator(".agencyTemplateListRow").filter({ hasText: "Agency Cleaning Reusable" });
  await savedTemplateRow.getByText("Version 1", { exact: false }).waitFor();
  const sourceTemplateId = new URL(await savedTemplateRow.getByRole("link", { name: "Use template" }).getAttribute("href"), baseUrl)
    .searchParams.get("templateId");
  assert(sourceTemplateId, "Published Agency template was not offered for client provisioning.");
  await savedTemplateRow.getByRole("link", { name: "Use template" }).click();
  await page.getByRole("heading", { name: "Create a client workspace" }).waitFor();
  assert(await page.getByLabel("Starting setup").inputValue() === sourceTemplateId,
    "Use template did not select the correct Agency template.");
  await page.getByLabel("Business name").fill("UI Templated Client");
  await page.getByRole("button", { name: "Create from template" }).click();
  await page.waitForURL((url) => url.pathname === "/setup/business");
  const uiClone = await pool.query(`SELECT a.status AS agent_status, a.opening_message,
    p.business_name, p.summary, p.phone, p.website_url, w.balance,
    x.template_version, x.template_id
    FROM ai_agents a
    JOIN business_profiles p ON p.workspace_id = a.workspace_id
    JOIN credit_wallets w ON w.workspace_id = a.workspace_id
    JOIN agency_workspace_template_applications x ON x.workspace_id = a.workspace_id
    WHERE x.purchaser_user_id = $1 AND x.template_id = $2`, [userId, sourceTemplateId]);
  assert(uiClone.rowCount === 1 && uiClone.rows[0].agent_status === "DRAFT"
    && uiClone.rows[0].business_name === "UI Templated Client"
    && uiClone.rows[0].opening_message === "Hello from UI Templated Client!"
    && uiClone.rows[0].summary === "Reusable commercial cleaning assistance"
    && uiClone.rows[0].phone === null && uiClone.rows[0].website_url === null
    && uiClone.rows[0].balance === 0 && uiClone.rows[0].template_version === 1,
  "Agency template UI did not produce an isolated, zero-funded draft client.");
  await page.goto(`${baseUrl}/workspaces/templates`, { waitUntil: "networkidle" });
  const editingRow = page.locator(".agencyTemplateListRow").filter({ hasText: "Agency Cleaning Reusable" });
  await editingRow.getByRole("button", { name: "Review / edit" }).click();
  await page.getByLabel("Agent name").fill("Mia Two");
  await page.getByRole("checkbox", { name: /reviewed this template/i }).check();
  await page.getByRole("button", { name: "Publish new version" }).click();
  await page.getByText("New template version published.").waitFor();
  const priorClone = await pool.query(`SELECT name FROM ai_agents WHERE workspace_id =
    (SELECT workspace_id FROM agency_workspace_template_applications
     WHERE purchaser_user_id = $1 AND template_id = $2)`, [userId, sourceTemplateId]);
  assert(priorClone.rows[0]?.name === "Mia", "Editing Agency template modified an existing client agent.");
  await pool.query(`UPDATE licenses SET status = 'REFUNDED'
    WHERE purchaser_user_id = $1 AND product_code IN ('AGENCY_50', 'AGENCY_100')`, [userId]);
  inventory = await context.request.get(`${baseUrl}/api/agency/workspaces`);
  assert(inventory.status() === 403, "Refunded Agency purchase kept dashboard API access.");
  await page.goto(`${baseUrl}/workspaces`);
  assert(await page.getByRole("heading", { name: "Workspaces" }).count() === 0,
    "Refunded Agency purchase kept dashboard page access.");
  const preserved = await pool.query(`SELECT count(*)::int AS total FROM memberships
    WHERE user_id = $1 AND role = 'OWNER'`, [userId]);
  assert(preserved.rows[0].total === 5, "Agency refund deleted an existing or templated client workspace.");
  const blocked = await context.request.put(`${baseUrl}/api/workspaces`, {
    data: { name: "After Agency Refund" },
  });
  assert(blocked.status() === 403, "Existing over-limit buyer created another workspace.");
  assert(failures.length === 0, `Browser errors: ${failures.join("; ")}`);
  console.log("Agency workspace browser acceptance passed.");
} finally {
  if (clientContext) await clientContext.close();
  await browser.close();
  await pool.end();
}
