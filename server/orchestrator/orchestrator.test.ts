import { describe, expect, it, vi } from "vitest";
import { createResponseOrchestrator } from "./index";
import { parseOrchestratorEnvelope } from "./tools";

function fakeContext(handlingMode: "AI" | "HUMAN" = "AI") {
  return {
    workspaceId: "00000000-0000-0000-0000-000000000001",
    conversation: {
      id: "00000000-0000-0000-0000-000000000002",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      contactId: "00000000-0000-0000-0000-000000000003",
      status: "OPEN",
      handlingMode,
      assignedUserId: null,
      lastMessageAt: null,
      aiPausedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    contact: {
      id: "00000000-0000-0000-0000-000000000003",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      name: "Ada",
      email: "ada@example.com",
      phone: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      identities: [],
      tags: [],
      lead: null,
      appointments: [],
    },
    business: null,
    agent: null,
    timezone: "UTC",
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

  it("does not invoke AI while a human owns the conversation", async () => {
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("HUMAN")) as any,
      executeTools: vi.fn() as any,
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
      buildContext: vi.fn(async () => fakeContext("AI")) as any,
      executeTools: executeTools as any,
      generate,
    });

    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBe("I have a 10:00 AM opening tomorrow.");
    expect(result.toolResult.kind).toBe("availability");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(executeTools).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls[1][2])).toContain("2026-09-18T10:00:00.000Z");
  });
});
