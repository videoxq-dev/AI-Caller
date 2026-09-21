import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, db } from "@/db";
import { appointments, automationEvents, workspaces } from "@/db/schema";
import { saveBusinessSetup } from "@/server/domain/onboarding/repository";
import { createContact, getContactDetail, listAppointments } from "./repository";
import { calendarBookingService } from "./calendar-booking";
import { withinBusinessHours } from "./native-calendar";

describe("native in-app appointment booking without external calendar", () => {
  let workspaceId = "";
  let contactId = "";
  beforeEach(async () => {
    await db.delete(workspaces);
    const [workspace] = await db.insert(workspaces).values({ name: "Native calendar business" }).returning();
    workspaceId = workspace.id;
    await saveBusinessSetup(workspaceId, {
      businessName: "Office Cleaning", timezone: "UTC", completeStep: true,
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, enabled: true, openTime: "08:00", closeTime: "18:00",
      })),
    });
    const contact = await createContact(workspaceId, {
      name: "A caller without email", email: null, phone: "+13074453684",
      notes: null, tags: [], identities: [],
    });
    contactId = contact.id;
  });
  afterAll(async () => closeDatabase());

  const start = new Date("2030-09-23T10:00:00.000Z");
  const end = new Date("2030-09-23T14:00:00.000Z");
  function booking(contactId: string) {
    return {
      contactId, conversationId: null, serviceId: null, title: "Office Cleaning",
      startsAt: start, endsAt: end, timezone: "UTC", bookingSource: "WEBCHAT_AI",
      notes: null, attendeeName: "A caller without email", attendeeEmail: null,
    };
  }

  it("offers live native slots and records an appointment without an email/calendar integration", async () => {
    const available = await calendarBookingService.getAvailability(workspaceId, {
      startsAt: new Date("2030-09-23T08:00:00.000Z"),
      endsAt: new Date("2030-09-23T18:00:00.000Z"),
      timezone: "UTC", durationMinutes: 240,
    });
    expect(available.some(slot => slot.startsAt.getTime() === start.getTime())).toBe(true);
    const result = await calendarBookingService.book(workspaceId, booking(contactId));
    expect(result).toMatchObject({
      status: "CONFIRMED", externalEventId: null, integrationId: null, title: "Office Cleaning",
    });
    const listed = await listAppointments(workspaceId);
    expect(listed.total).toBe(1);
    expect(listed.items[0].appointment.id).toBe(result.id);
    expect((await getContactDetail(workspaceId, contactId))?.appointments).toHaveLength(1);
    const events = await db.select().from(automationEvents)
      .where(eq(automationEvents.workspaceId, workspaceId));
    expect(events.filter(event => event.type === "APPOINTMENT_CONFIRMED")).toHaveLength(1);
    const after = await calendarBookingService.getAvailability(workspaceId, {
      startsAt: start, endsAt: end, timezone: "UTC", durationMinutes: 240,
    });
    expect(after).toHaveLength(0);
  });

  it("serializes competing requests for the same slot and prevents double booking", async () => {
    const result = await Promise.allSettled([
      calendarBookingService.book(workspaceId, booking(contactId)),
      calendarBookingService.book(workspaceId, booking(contactId)),
    ]);
    expect(result.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(row => row.status === "rejected")).toHaveLength(1);
    expect((await listAppointments(workspaceId)).total).toBe(1);
  });

  it("does not book a past or out-of-hours appointment", async () => {
    await expect(calendarBookingService.book(workspaceId, {
      ...booking(contactId), startsAt: new Date("2030-09-23T19:00:00.000Z"),
      endsAt: new Date("2030-09-23T20:00:00.000Z"),
    })).rejects.toMatchObject({ code: "APPOINTMENT_OUTSIDE_HOURS" });
    await expect(calendarBookingService.book(workspaceId, {
      ...booking(contactId), startsAt: new Date("2020-09-23T10:00:00.000Z"),
      endsAt: new Date("2020-09-23T14:00:00.000Z"),
    })).rejects.toMatchObject({ code: "APPOINTMENT_IN_PAST" });
  });

  it("uses local business hours, not UTC wall-clock hours", () => {
    const hours = [{ dayOfWeek: 1, enabled: true, openTime: "08:00", closeTime: "18:00" }];
    const nyStart = new Date("2030-09-23T14:00:00Z");
    const nyEnd = new Date("2030-09-23T18:00:00Z");
    const businessDay = new Date(nyStart).toLocaleDateString("en-US", {
      timeZone: "America/New_York", weekday: "short",
    });
    if (businessDay === "Mon") {
      expect(withinBusinessHours({ startsAt: nyStart, endsAt: nyEnd }, "America/New_York", hours)).toBe(true);
      expect(withinBusinessHours({ startsAt: new Date("2030-09-23T23:00:00Z"),
        endsAt: new Date("2030-09-24T00:00:00Z") }, "America/New_York", hours)).toBe(false);
    }
  });
});
