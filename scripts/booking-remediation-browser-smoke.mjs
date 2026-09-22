import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL || process.env.AI_CALLER_E2E_FIXTURES !== "1") {
  throw new Error("Booking browser acceptance requires an isolated database and guarded fixtures.");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const page = await browser.newPage({ viewport: { width: 420, height: 840 } });
const dir = path.join(process.cwd(), "artifacts", "booking-remediation");
await mkdir(dir, { recursive: true });
const assert = (value, message) => { if (!value) throw new Error(message); };

try {
  const workspaceId = randomUUID(), key = "booking-smoke-" + randomUUID();
  await pool.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Booking Test Workspace')", [workspaceId]);
  await pool.query("INSERT INTO ai_agents (workspace_id, name, status) VALUES ($1, 'Mia', 'ACTIVE')", [workspaceId]);
  await pool.query("INSERT INTO business_profiles (workspace_id, business_name, timezone) VALUES ($1, 'Booking Test Workspace', 'Africa/Lagos')", [workspaceId]);
  await pool.query("INSERT INTO business_hours (workspace_id, day_of_week, enabled, open_time, close_time) SELECT $1,n,true,'08:00','19:00' FROM generate_series(0,6) n", [workspaceId]);
  await pool.query("INSERT INTO services (workspace_id,name,duration_minutes,active) VALUES ($1,'Office Cleaning',240,true)", [workspaceId]);
  await pool.query("INSERT INTO webchat_widgets (workspace_id,public_key,enabled) VALUES ($1,$2,true)", [workspaceId,key]);
  await pool.query("INSERT INTO credit_wallets (workspace_id,balance) VALUES ($1,1000)", [workspaceId]);

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/widget/${key}`, { waitUntil: "networkidle" });
  const composer = page.getByPlaceholder("Type your message…");
  await composer.waitFor({ timeout: 20_000 });
  const send = async (value) => {
    await composer.fill(value);
    await page.getByRole("button", { name: "Send message" }).click();
  };
  await send("Book Office Cleaning");
  await page.getByText("What date would you prefer for the appointment?").waitFor({ timeout: 20_000 });
  await send("Tomorrow");
  await page.getByText("What start time would you prefer?").waitFor({ timeout: 20_000 });
  await send("11 AM");
  await page.getByRole("button", { name: "Confirm appointment" }).waitFor({ timeout: 20_000 });
  const selected = await pool.query("SELECT b.id AS draft_id,b.current_preview_id AS preview_id,b.version,b.status,p.content FROM booking_drafts b JOIN booking_previews p ON p.id=b.current_preview_id WHERE b.workspace_id=$1",[workspaceId]);
  assert(selected.rows.length===1 && selected.rows[0].status==="AWAITING_CONFIRMATION",
    "The booking preview was not persisted for the authenticated widget.");
  const preview=selected.rows[0],expectedStart=new Date(Date.now()+60*60_000);
  expectedStart.setUTCDate(expectedStart.getUTCDate()+1);
  expectedStart.setUTCHours(10,0,0,0);
  assert(preview.content.startsAt===expectedStart.toISOString(),
    "The AI failed to preserve the requested date/time across widget turns.");
  const noBooking=await pool.query("SELECT count(*)::int AS n FROM appointments WHERE workspace_id=$1",[workspaceId]);
  assert(noBooking.rows[0].n===0,"The booking executed before the customer confirmed.");
  await page.screenshot({ path: path.join(dir,"preview.png"), fullPage:true });
  await page.getByRole("button",{name:"Confirm appointment"}).click();
  await page.getByText(/Your Office Cleaning appointment is confirmed for/).last()
    .waitFor({timeout:20_000});
  await page.getByText("Confirmed",{exact:true}).first().waitFor({timeout:10_000});

  const saved=await pool.query("SELECT id,starts_at,ends_at,booking_command_id FROM appointments WHERE workspace_id=$1",[workspaceId]);
  assert(saved.rows.length===1,"The customer confirmation did not create exactly one appointment.");
  assert(new Date(saved.rows[0].starts_at).toISOString()===expectedStart.toISOString(),
    "The appointment start differs from the selected instant.");
  assert(new Date(saved.rows[0].ends_at).getTime()-new Date(saved.rows[0].starts_at).getTime()===240*60_000,
    "The four-hour service has the wrong persisted duration.");
  const count=await pool.query("SELECT count(*)::int AS n FROM automation_events WHERE workspace_id=$1 AND type='APPOINTMENT_CONFIRMED'",[workspaceId]);
  assert(count.rows[0].n===1,"The booking did not emit exactly one confirmed event.");

  const token=await page.evaluate((widgetKey)=>
    window.localStorage.getItem("ai-caller:session:"+widgetKey),key);
  assert(token,"Widget bearer token not persisted.");
  const retry=await page.request.post(`${baseUrl}/api/widget/bookings/confirm`,{
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    data:JSON.stringify({draftId:preview.draft_id,previewId:preview.preview_id,
      expectedVersion:preview.version,clientEventId:randomUUID()}),
  });
  assert(retry.ok(),`Repeat confirm failed HTTP ${retry.status()} ${(await retry.text()).slice(0,500)}`);
  const repeated=await pool.query("SELECT count(*)::int AS n FROM appointments WHERE workspace_id=$1",[workspaceId]);
  assert(repeated.rows[0].n===1,"Repeated customer approval created another appointment.");
  await send("is it booked?");
  await page.getByText(/Your Office Cleaning appointment is confirmed for/).last().waitFor({ timeout: 20_000 });
  await page.reload({waitUntil:"networkidle"});
  await page.getByText("Confirmed",{exact:true}).first().waitFor({timeout:20_000});
  assert(await page.getByRole("button",{name:"Confirm appointment"}).count()===0,
    "A refreshed confirmed preview allows another confirmation.");
  await page.screenshot({path:path.join(dir,"confirmed-after-refresh.png"),fullPage:true});

  const foreign=await page.request.post(`${baseUrl}/api/widget/session`,{
    data:{widgetKey:key},
  });
  assert(foreign.ok(),"Isolation-test session creation failed.");
  const otherToken=(await foreign.json()).sessionToken;
  const denied=await page.request.post(`${baseUrl}/api/widget/bookings/confirm`,{
    headers:{authorization:"Bearer "+otherToken,"content-type":"application/json"},
    data:JSON.stringify({draftId:preview.draft_id,previewId:preview.preview_id,
      expectedVersion:preview.version,clientEventId:randomUUID()}),
  });
  assert([403,404,409].includes(denied.status()),
    "Another widget session confirmed a booking using opaque IDs.");
  assert(errors.length===0,`Widget page errors: ${errors.join("; ")}`);
  console.log("PASS: booking widget persisted exact 240-minute appointment, receipt, replay and refresh.");
} finally {
  await browser.close();
  await pool.end();
}
