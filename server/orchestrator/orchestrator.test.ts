import { describe, expect, it, vi } from "vitest";
import { createResponseOrchestrator } from "./index";
import { parseOrchestratorEnvelope } from "./tools";

function fakeContext(handlingMode: "AI" | "HUMAN" = "AI") {
  return {
    workspaceId: "00000000-0000-0000-0000-000000000001",
    conversation: { handlingMode },
    contact: { id: "00000000-0000-0000-0000-000000000003" },
    agent: null,
    systemPrompt: "You are the assistant.",
    messages: [{ role: "user" as const, content: "Can I book tomorrow?" }],
  };
}

describe("orchestrator response protocol", () => {
  it("falls back to a safe text-only response when provider output is not JSON", () => {
    expect(parseOrchestratorEnvelope("I can help with that.")).toEqual({
      reply: "I can help with that.",
      action: { type: "NONE" },
    });
  });

  it("rejects malformed or invalid structured actions instead of exposing raw JSON", () => {
    expect(() => parseOrchestratorEnvelope('{"action":{"type":"BOOK_APPOINTMENT"}}')).toThrow("invalid orchestration action");
    expect(() => parseOrchestratorEnvelope(JSON.stringify({
      action: {
        type: "BOOK_APPOINTMENT",
        startsAt: "2026-09-18T11:00:00Z",
        endsAt: "2026-09-18T10:00:00Z",
        timezone: "UTC",
        title: "Consultation",
      },
    }))).toThrow("invalid orchestration action");
    expect(() => parseOrchestratorEnvelope(JSON.stringify({
      action: {
        type: "CHECK_AVAILABILITY",
        startsAt: "2026-09-18T09:00:00Z",
        endsAt: "2026-09-18T17:00:00Z",
        timezone: "Definitely/Not-A-Timezone",
      },
    }))).toThrow("invalid orchestration action");
  });

  it("does not invoke AI while a human owns the conversation", async () => {
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("HUMAN")),
      executeTools: vi.fn(),
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("HUMAN");
    expect(result.reply).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses an authoritative availability result before answering the customer", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: {
            type: "CHECK_AVAILABILITY",
            startsAt: "2026-09-18T09:00:00Z",
            endsAt: "2026-09-18T17:00:00Z",
            timezone: "UTC",
            durationMinutes: 30,
          },
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ reply: "I have a 10:00 AM opening tomorrow.", action: { type: "NONE" } }),
      });
    const executeTools = vi.fn().mockResolvedValue({
      kind: "availability",
      data: { slots: [{ startsAt: "2026-09-18T10:00:00.000Z", endsAt: "2026-09-18T10:30:00.000Z" }] },
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools,
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBe("I have a 10:00 AM opening tomorrow.");
    expect(result.toolResult.kind).toBe("availability");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls[1][2])).toContain("2026-09-18T10:00:00.000Z");
  });

  it("returns an authoritative confirmation if the AI finalizer fails after booking", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          action: {
            type: "BOOK_APPOINTMENT",
            startsAt: "2026-09-18T10:00:00Z",
            endsAt: "2026-09-18T10:30:00Z",
            timezone: "UTC",
            title: "Consultation",
          },
        }),
      })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const executeTools = vi.fn().mockResolvedValue({
      kind: "booking",
      data: {
        appointmentId: "appointment-1",
        title: "Consultation",
        startsAt: "2026-09-18T10:00:00.000Z",
        endsAt: "2026-09-18T10:30:00.000Z",
        timezone: "UTC",
        status: "CONFIRMED",
      },
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools,
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.toolResult.kind).toBe("booking");
    expect(result.reply).toContain("Consultation is booked");
    expect(result.reply).toContain("UTC");
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
