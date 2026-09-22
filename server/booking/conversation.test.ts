import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { aiAgents, appointments, bookingDrafts, bookingOffers, services, webchatSessions, workspaces } from "@/db/schema";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { createOrResumeWebchatSession, ensureWebchatWidget } from "@/server/webchat/repository";
import { generateAIWithUsage } from "@/server/orchestrator/usage";
import { POST } from "@/app/api/widget/messages/route";

vi.mock("@/server/orchestrator/usage", () => ({ generateAIWithUsage: vi.fn() }));

describe("booking conversation through the authenticated widget (disposable PostgreSQL)", () => {
  let workspaceId: string, serviceId: string, token: string, sessionId: string;
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AI_CALLER_BOOKING_V2", "");
    vi.mocked(generateAIWithUsage).mockReset();
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Booking regression" }).returning();
    workspaceId = workspace.id;
    await db.insert(aiAgents).values({ workspaceId, name: "Mia", status: "ACTIVE" });
    const [service] = await db.insert(services).values({ workspaceId, name: "Office Cleaning", durationMinutes: 240 }).returning();
    serviceId = service.id;
    await saveBusinessSetup(workspaceId, { businessName: "Cleaning", timezone: "Africa/Lagos", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, enabled: true, openTime: "08:00", closeTime: "19:00" })) });
    const widget = await ensureWebchatWidget(workspaceId);
    const session = await createOrResumeWebchatSession({ widgetKey: widget.publicKey });
    token = session!.sessionToken;
    sessionId = session!.sessionId;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await closeDatabase(); });

  function plan(value: Record<string, unknown>) {
    vi.mocked(generateAIWithUsage).mockResolvedValueOnce({ text: JSON.stringify(value) });
  }
  async function send(message: string) {
    const response = await POST(new Request("http://localhost/api/widget/messages", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ clientMessageId: randomUUID(), message }),
    }));
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).not.toContain("event: error");
    const chunks = stream.split("\n\n").filter(item => item.startsWith("event: message\n"));
    return chunks.map(item => JSON.parse(item.split("\ndata: ")[1]).delta).join("");
  }
  async function preview() {
    plan({ action: "PATCH" });
    expect(await send("i want to book a cleaning service")).toContain("Which service");
    plan({ action: "PATCH", serviceId, location: "Sheridan", dateExpression: "September 25 2037" });
    expect(await send("office cleaning in sheridan. i want it done on September 25 2037")).toContain("start time");
    plan({ action: "PATCH", timeExpression: "11 am" });
    const reply = await send("11 am");
    expect(reply).toContain("11:00 AM");
    expect(reply).toContain("Africa/Lagos");
    expect(reply).toContain("Shall I book");
    expect(await db.select().from(appointments)).toHaveLength(0);
  }

  it("uses the durable engine without hidden rollout flags and books split details on yes", async () => {
    const [session] = await db.select().from(webchatSessions).where(eq(webchatSessions.id, sessionId));
    expect(session.bookingEngineVersion).toBe("v2");
    await preview();
    expect(await send("yes")).toContain("appointment is confirmed");
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
    expect(rows[0].startsAt.toISOString()).toBe("2037-09-25T10:00:00.000Z");
    expect(rows[0].endsAt.toISOString()).toBe("2037-09-25T14:00:00.000Z");
    expect(rows[0].notes).toBe("Sheridan");
    expect(generateAIWithUsage).toHaveBeenCalledTimes(3);
  });

  it("answers repeated yes and booking status from the saved receipt", async () => {
    await db.update(webchatSessions).set({ bookingEngineVersion: "v2" }).where(eq(webchatSessions.id, sessionId));
    await preview();
    await send("yes");
    expect(await send("yes")).toContain("confirmed");
    expect(await send("is it booked?")).toContain("confirmed");
    expect(await db.select().from(appointments)).toHaveLength(1);
    expect(generateAIWithUsage).toHaveBeenCalledTimes(3);
  });

  it("renews the preview after a side question so the next yes can confirm", async () => {
    await db.update(webchatSessions).set({ bookingEngineVersion: "v2" }).where(eq(webchatSessions.id, sessionId));
    await preview();
    plan({ action: "QUESTION", question: "How long?" });
    expect(await send("how long does it take?")).toContain("240 minutes");
    plan({ action: "CHECK" });
    expect(await send("please show me the appointment again")).toContain("Shall I book");
    expect(await send("yes")).toContain("confirmed");
    expect(await db.select().from(appointments)).toHaveLength(1);
  });

  it("selects a stored range offer without reconstructing its time and asks for confirmation", async () => {
    plan({ action: "PATCH", serviceId, dateExpression: "September 25 2037", range: "DAY" });
    expect(await send("book office cleaning on September 25 2037, any time")).toContain("Available times include");
    expect(await send("yes")).toContain("Which of the offered times");
    const [offer] = await db.select().from(bookingOffers).orderBy(bookingOffers.startsAt);
    plan({ action: "SELECT", offerId: offer.id });
    expect(await send("the first one")).toContain("Shall I book");
    expect(await db.select().from(appointments)).toHaveLength(0);
    expect(await send("yes")).toContain("confirmed");
    const [appointment] = await db.select().from(appointments);
    expect(appointment.startsAt).toEqual(offer.startsAt);
  });

  it("preserves an explicit UTC time and renders it consistently through confirmation", async () => {
    plan({ action: "PATCH", serviceId, dateExpression: "September 25 2037", timeExpression: "11 am UTC" });
    expect(await send("book office cleaning on September 25 2037 at 11 am UTC")).toContain("(UTC)");
    expect(await send("yes")).toContain("(UTC)");
    expect(await send("is it booked?")).toContain("(UTC)");
    const [appointment] = await db.select().from(appointments);
    expect(appointment.startsAt.toISOString()).toBe("2037-09-25T11:00:00.000Z");
  });

  it("requires renewed approval after a date correction and never books the old preview", async () => {
    await preview();
    plan({ action: "PATCH", dateExpression: "September 26 2037" });
    expect(await send("yes but September 26 instead")).toContain("Shall I book");
    expect(await db.select().from(appointments)).toHaveLength(0);
    expect(await send("yes")).toContain("confirmed");
    const [appointment] = await db.select().from(appointments);
    expect(appointment.startsAt.toISOString()).toBe("2037-09-26T10:00:00.000Z");
  });

  it("switches an existing legacy session on a fresh booking request without copying old previews", async () => {
    await db.update(webchatSessions).set({ bookingEngineVersion: "v1" }).where(eq(webchatSessions.id, sessionId));
    await preview();
    const [session] = await db.select().from(webchatSessions).where(eq(webchatSessions.id, sessionId));
    expect(session.bookingEngineVersion).toBe("v2");
    expect(await send("yes")).toContain("confirmed");
  });

  it("does not lose a draft when extraction returns null for omitted optional fields", async () => {
    await db.update(webchatSessions).set({ bookingEngineVersion: "v2" }).where(eq(webchatSessions.id, sessionId));
    plan({ action: "PATCH", serviceId, dateExpression: "September 25 2037", timeExpression: null,
      timezone: null, location: "Sheridan", question: null, range: null });
    expect(await send("book office cleaning in Sheridan on September 25 2037")).toContain("start time");
    const [draft] = await db.select().from(bookingDrafts);
    expect(draft.localDate).toBe("2037-09-25");
    expect(draft.requiredLocation).toBe("Sheridan");
  });

  it("does not invoke extraction or create a draft for a paused agent", async () => {
    await db.update(aiAgents).set({ status: "PAUSED" }).where(eq(aiAgents.workspaceId, workspaceId));
    expect(await send("I want to book a cleaning service")).toBe("");
    expect(generateAIWithUsage).not.toHaveBeenCalled();
    expect(await db.select().from(bookingDrafts)).toHaveLength(0);
  });
});
