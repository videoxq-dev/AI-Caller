import { describe, expect, it, vi } from "vitest";
import { createResponseOrchestrator } from "./index";
import { parseOrchestratorEnvelope } from "./tools";
import { defaultAgentCapabilities } from "@/server/agent/capabilities";
import { AppError } from "@/server/http/errors";

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


  it.each(["DRAFT", "PAUSED"] as const)("does not call AI or tools for a %s live agent", async status => {
    const generate = vi.fn();
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(executeTools).not.toHaveBeenCalled();
  });

  it("does not invoke AI if answering is disabled, even without installed workflows", async () => {
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ANSWER_INQUIRY: false } } },
      })),
      executeTools: vi.fn(), generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses default agent behavior without a configured workflow", async () => {
    const generate = vi.fn(async () => ({ text: JSON.stringify({ action: { type: "NONE" },
      reply: "We offer the services in our approved business profile." }) }));
    const executeTools = vi.fn(async () => ({ kind: "none" as const, data: {} }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
      })),
      executeTools, generate,
    });
    expect((await orchestrator.respond("workspace", "conversation")).reply)
      .toContain("approved business profile");
    expect(executeTools).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("responds truthfully when a configured capability is revoked during model planning", async () => {
    const generate = vi.fn(async () => ({ text: JSON.stringify({
      reply: "Your appointment is confirmed.",
      action: { type: "BOOK_APPOINTMENT", startsAt: "2026-09-22T10:00:00Z",
        endsAt: "2026-09-22T10:30:00Z", timezone: "UTC", title: "Consultation" },
    }) }));
    const executeTools = vi.fn(async () => {
      throw new AppError("AGENT_ACTION_DISABLED", "Booking is disabled.", 403);
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext()), executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("can't perform that action");
    expect(result.reply).not.toContain("confirmed");
    expect(generate).toHaveBeenCalledOnce();
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("answers normally when disabled metadata fields are supplied by an untrusted model", async () => {
    const executeTools = vi.fn(async () => ({ kind: "none" as const, data: {} }));
    const generate = vi.fn(async (
      _workspaceId: string, _conversationId: string,
      _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    ) => ({ text: JSON.stringify({
      reply: "Our current consultation is thirty minutes.",
      contact: { name: "Invented person" },
      lead: { status: "QUALIFIED", intent: "Invented interest" },
      action: { type: "NONE" },
    }) }));
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext(), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: {
            ...defaultAgentCapabilities, UPDATE_CONTACT: false,
            UPDATE_LEAD: false, QUALIFY_LEAD: false,
          } } },
      })),
      executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toBe("Our current consultation is thirty minutes.");
    expect(executeTools).toHaveBeenCalledWith("workspace", "conversation",
      fakeContext().contact.id,
      expect.objectContaining({ contact: undefined, lead: undefined, action: { type: "NONE" } }));
    expect(String(generate.mock.calls[0]?.[2]?.[0]?.content))
      .not.toContain('"contact": {');
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

  it.each([
    "an operator",
    "How can I speak to a human?",
    "I need to talk to a team member",
  ])("escalates explicit live caller request %s without promising a live transfer", async (utterance) => {
    const context = {
      ...fakeContext("AI"),
      systemPrompt: "LIVE PHONE RECEPTIONIST: answer caller.",
      messages: [{ role: "user" as const, content: utterance }],
    };
    const executeTools = vi.fn().mockResolvedValue({
      kind: "escalation", data: { handlingMode: "HUMAN" },
    });
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => context), executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("HUMAN");
    expect(result.reply).toContain("I can't transfer this call live.");
    expect(executeTools).toHaveBeenCalledWith("workspace", "conversation",
      context.contact.id, { action: {
        type: "ESCALATE", reason: "Caller requested a human during a phone call.",
      } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not promise staff follow-up when phone escalation is disabled", async () => {
    const executeTools = vi.fn();
    const generate = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext("AI"), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities, ESCALATE: false } } },
        systemPrompt: "LIVE PHONE RECEPTIONIST:",
        messages: [{ role: "user" as const, content: "Can I speak to a human?" }],
      })),
      executeTools, generate,
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).toContain("can't arrange staff follow-up");
    expect(result.reply).not.toContain("I've flagged");
    expect(executeTools).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not claim staff follow-up if escalation is revoked while a phone turn is in progress", async () => {
    const executeTools = vi.fn(async () => {
      throw new AppError("AGENT_ACTION_DISABLED", "Escalation is disabled.", 403);
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => ({
        ...fakeContext("AI"), source: "INBOUND_TURN" as const,
        agent: { id: "agent-1", status: "ACTIVE" as const, escalationMessage: null,
          behaviorSettings: { capabilities: { ...defaultAgentCapabilities } } },
        systemPrompt: "LIVE PHONE RECEPTIONIST:",
        messages: [{ role: "user" as const, content: "I need to speak to a person." }],
      })),
      executeTools, generate: vi.fn(),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.handlingMode).toBe("AI");
    expect(result.reply).not.toContain("I've flagged");
    expect(executeTools).toHaveBeenCalledOnce();
  });

  it("suppresses a model-only live transfer promise when no transfer or escalation occurred", async () => {
    const context = {
      ...fakeContext("AI"),
      systemPrompt: "LIVE PHONE RECEPTIONIST:",
      messages: [{ role: "user" as const, content: "What services do you offer?" }],
    };
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => context),
      executeTools: vi.fn(async () => ({ kind: "none" as const, data: {} })),
      generate: vi.fn(async () => ({
        text: JSON.stringify({ reply: "I'll connect you with our team to book office cleaning.", action: { type: "NONE" } }),
      })),
    });
    const result = await orchestrator.respond("workspace", "conversation");
    expect(result.reply).toContain("I can't transfer this call live.");
    expect(result.reply).not.toContain("I'll connect");
    expect(result.handlingMode).toBe("AI");
  });

  it("does not perform irreversible tools for an utterance superseded during AI generation", async () => {
    const executeTools = vi.fn();
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({ reply: "I will book your appointment now.", action: { type: "NONE" } }),
    });
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => fakeContext("AI")),
      executeTools, generate,
    });
    const beforeTools = vi.fn(async () => false);
    const result = await orchestrator.respond("workspace", "conversation", { beforeTools });
    expect(result.reply).toBeNull();
    expect(executeTools).not.toHaveBeenCalled();
    expect(beforeTools).toHaveBeenCalledTimes(1);
  });

  it("does not escalate after the caller supersedes a human-request fragment", async () => {
    const context = {
      ...fakeContext("AI"),
      systemPrompt: "LIVE PHONE RECEPTIONIST:",
      messages: [{ role: "user" as const, content: "an operator" }],
    };
    const executeTools = vi.fn();
    const orchestrator = createResponseOrchestrator({
      buildContext: vi.fn(async () => context),
      executeTools, generate: vi.fn(),
    });
    const result = await orchestrator.respond("workspace", "conversation", {
      beforeTools: async () => false,
    });
    expect(result.reply).toBeNull();
    expect(executeTools).not.toHaveBeenCalled();
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
