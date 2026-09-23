import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
const outputDir = path.join(process.cwd(), "artifacts", "phase6a-whatsapp-templates");
await mkdir(outputDir, { recursive: true });

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function noOverflow(page, label) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(widths.page - widths.viewport <= 2, `${label}: unexpected horizontal overflow.`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("response", response => {
  if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`);
});
let approved = false;
const submitted = [];
let latestSubmission = null;

try {
  const stamp = Date.now();
  const signup = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
    data: { name: "WhatsApp Template Owner", email: `phase6a-${stamp}@example.com`,
      password: "Phase6aBrowserPass123!" },
  });
  assert(signup.ok(), `Sign up failed: ${await signup.text()}`);

  await page.route("**/api/integrations", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ integrations: [{
      provider: "whatsapp", status: "CONNECTED", settings: {
        wabaName: "Acme", displayPhoneNumber: "+15551234567",
      },
    }] }),
  }));
  await page.route("**/api/integrations/meta/config", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ enabled: false, appId: null, configId: null, graphApiVersion: "v22.0" }),
  }));
  await page.route("**/api/integrations/whatsapp/templates*", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      latestSubmission = request.postDataJSON();
      submitted.push({
        id: "new-template", name: latestSubmission.name,
        language: latestSubmission.language, category: latestSubmission.category,
        status: "PENDING", body: latestSubmission.body, footer: latestSubmission.footer,
        rejectionReason: null,
      });
      await route.fulfill({ status: 201, contentType: "application/json",
        body: JSON.stringify({ template: {
          id: "new-template", name: latestSubmission.name,
          language: latestSubmission.language, category: latestSubmission.category,
          status: "PENDING",
        } }),
      });
      return;
    }
    const cursor = new URL(request.url()).searchParams.get("after");
    const items = cursor ? [{
      id: "old-rejection", name: "outdated_offer", language: "en_US",
      category: "MARKETING", status: "REJECTED", body: "An outdated offer",
      footer: "", rejectionReason: "POLICY",
    }] : [{
      id: "already-approved", name: "welcome_message", language: "en_US",
      category: "UTILITY", status: "APPROVED", body: "Welcome to Acme",
      footer: "", rejectionReason: null,
    }, ...submitted.map(template => ({ ...template, status: approved ? "APPROVED" : "PENDING" }))];
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ items, nextCursor: cursor ? null : "cGFnZTI=" }) });
  });

  await page.goto(`${baseUrl}/integrations?provider=whatsapp`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /Manage message templates/ }).click();
  await page.getByRole("heading", { name: "Message templates" }).waitFor();
  await page.getByText("welcome message").waitFor();
  await page.getByRole("button", { name: "Load more" }).click();
  await page.getByText("outdated offer", { exact: true }).waitFor();
  const rejected = page.locator(".waTemplateCard").filter({ hasText: "outdated offer" });
  await rejected.locator("summary").click();
  await rejected.getByText("Meta rejection reason: POLICY").waitFor();

  await page.getByRole("button", { name: "New template" }).click();
  const form = page.locator(".waTemplateForm");
  await form.getByLabel("Template name").fill("Meeting reminder");
  await form.getByLabel("Message body").fill("Hi {{1}}, your appointment is on {{2}}.");
  await form.getByLabel("Example for {{1}}").fill("Ada");
  await form.getByLabel("Example for {{2}}").fill("Thursday at 10 AM");
  await form.getByLabel("Footer").fill("See you soon");
  await form.getByRole("button", { name: "Submit to Meta" }).click();
  await page.getByText(/meeting_reminder.*submitted to Meta/i).waitFor();
  assert(submitted.length === 1, "Template submission did not execute exactly once.");
  assert(latestSubmission.name === "meeting_reminder", "Template name was not normalized.");
  assert(JSON.stringify(latestSubmission.samples) === JSON.stringify(["Ada", "Thursday at 10 AM"]),
    "Template variable examples were not submitted in placeholder order.");
  const card = page.locator(".waTemplateCard").filter({ hasText: "meeting reminder" });
  await card.locator(".waStatus").getByText("Pending").waitFor();

  await noOverflow(page, "desktop WhatsApp templates");
  await page.screenshot({ path: path.join(outputDir, "templates-desktop.png"), fullPage: true });
  approved = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await card.locator(".waStatus").getByText("Approved").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page, "mobile WhatsApp templates");
  await page.screenshot({ path: path.join(outputDir, "templates-mobile.png"), fullPage: true });
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  process.stdout.write("Phase 6A template management browser acceptance passed: navigation, pagination, submission, Meta status refresh, responsive UI.\\n");
} finally {
  await context.close();
  await browser.close();
}
