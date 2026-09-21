import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { capabilityBindings, workspaces } from "@/db/schema";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { getCalendarSetup, saveCalendarSetup } from "./repository";

describe("native calendar onboarding", () => {
  let workspaceId = "";

  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Native Calendar Setup" }).returning();
    workspaceId = workspace.id;
  });

  afterAll(async () => closeDatabase());

  it("completes calendar setup from business hours without requiring an external provider", async () => {
    await saveBusinessSetup(workspaceId, {
      businessName: "Native Scheduler",
      timezone: "America/New_York",
      completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        enabled: dayOfWeek >= 1 && dayOfWeek <= 5,
        openTime: dayOfWeek >= 1 && dayOfWeek <= 5 ? "08:00" : null,
        closeTime: dayOfWeek >= 1 && dayOfWeek <= 5 ? "18:00" : null,
      })),
    });

    await expect(saveCalendarSetup(workspaceId, {
      provider: "google",
      meetingDurationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      availableDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      startTime: "08:00",
      endTime: "18:00",
      timezone: "America/New_York",
      suggestAlternatives: true,
      eventType: "Appointment",
      meetingLocation: "In person",
      maxBookingsPerDay: 8,
      completeStep: true,
    })).resolves.toMatchObject({ timezone: "America/New_York" });

    expect(await getCalendarSetup(workspaceId)).toMatchObject({
      meetingDurationMinutes: 30,
      timezone: "America/New_York",
    });
    const [binding] = await db.select().from(capabilityBindings).where(and(
      eq(capabilityBindings.workspaceId, workspaceId),
      eq(capabilityBindings.capability, "CALENDAR"),
    )).limit(1);
    expect(binding).toBeUndefined();
  });

  it("requires usable business hours when no external calendar is connected", async () => {
    await saveBusinessSetup(workspaceId, {
      businessName: "Closed Business",
      timezone: "UTC",
      completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: false, openTime: null, closeTime: null,
      })),
    });

    await expect(saveCalendarSetup(workspaceId, {
      provider: "google",
      meetingDurationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      availableDays: ["Mon"],
      startTime: "09:00",
      endTime: "17:00",
      timezone: "UTC",
      suggestAlternatives: true,
      eventType: null,
      meetingLocation: null,
      maxBookingsPerDay: 8,
      completeStep: true,
    })).rejects.toMatchObject({ code: "BUSINESS_HOURS_NOT_CONFIGURED" });
  });
});
