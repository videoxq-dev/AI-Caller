import { describe, expect, it, vi } from "vitest";
import { createMetaTemplateClient, createWhatsAppTemplateSchema } from "./meta-templates";

const options = { accessToken: "private-token", wabaId: "123456789", graphApiVersion: "v22.0" };
const valid = {
  name: "appointment_reminder",
  language: "en_US",
  category: "UTILITY" as const,
  body: "Hi {{1}}, your appointment is on {{2}}.",
  footer: "See you soon",
  samples: ["Ada", "Thursday at 10 AM"],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("Meta WhatsApp template management", () => {
  it("submits text and body examples to the authorized WABA, preserving Meta's pending status", async () => {
    const fetcher = vi.fn(async () => json({ id: "template-123", status: "PENDING", category: "UTILITY" }));
    const client = createMetaTemplateClient(options, fetcher as typeof fetch);
    await expect(client.submit(valid)).resolves.toEqual({
      id: "template-123", name: valid.name, language: valid.language, status: "PENDING", category: "UTILITY",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v22.0/123456789/message_templates");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ authorization: "Bearer private-token" });
    expect(JSON.parse(String(request.body))).toEqual({
      name: valid.name, language: valid.language, category: "UTILITY",
      components: [
        { type: "BODY", text: valid.body, example: { body_text: [["Ada", "Thursday at 10 AM"]] } },
        { type: "FOOTER", text: valid.footer },
      ],
    });
  });

  it("lists authoritative approval status and projects only business-safe fields", async () => {
    const fetcher = vi.fn(async () => json({
      data: [
        {
          id: "template-1", name: "appointment_reminder", language: "en_US",
          status: "APPROVED", category: "UTILITY",
          components: [{ type: "BODY", text: "See you soon" }, { type: "FOOTER", text: "Thank you" }],
          opaqueProviderSecret: "not exposed",
        },
        {
          id: "template-2", name: "special_offer", language: "en_US",
          status: "REJECTED", category: "MARKETING", rejected_reason: "POLICY",
          components: [{ type: "BODY", text: "New offer" }],
        },
      ],
      paging: { next: "https://graph.facebook.com/should-not-be-followed", cursors: { after: "cDoxOjc=" } },
    }));
    const client = createMetaTemplateClient(options, fetcher as typeof fetch);
    const page = await client.list();
    expect(page).toMatchObject({
      items: [
        { name: "appointment_reminder", status: "APPROVED", body: "See you soon", footer: "Thank you" },
        { name: "special_offer", status: "REJECTED", rejectionReason: "POLICY" },
      ],
      nextCursor: "cDoxOjc=",
    });
    expect(JSON.stringify(page)).not.toContain("opaqueProviderSecret");
    await client.list("cDoxOjc=");
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    const secondUrl = calls[1]?.[0];
    expect(secondUrl).toBe("https://graph.facebook.com/v22.0/123456789/message_templates?limit=50&after=cDoxOjc%3D");
  });

  it("rejects malformed names, gaps, and absent placeholder examples before provider submission", async () => {
    const fetcher = vi.fn(async () => json({ id: "template-123", status: "PENDING", category: "UTILITY" }));
    const client = createMetaTemplateClient(options, fetcher as typeof fetch);
    for (const invalid of [
      { ...valid, name: "../another_waba" },
      { ...valid, body: "Hi {{2}}", samples: ["Ada"] },
      { ...valid, body: "Hi {{1}}", samples: [] },
      { ...valid, body: "Hi {{1}} {{wrong}}", samples: ["Ada"] },
      { ...valid, samples: ["Ada", "Thursday", "extra"] },
    ]) {
      expect(createWhatsAppTemplateSchema.safeParse(invalid).success).toBe(false);
      await expect(client.submit(invalid)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects untrusted cursors and never sends a request to the supplied address", async () => {
    const fetcher = vi.fn(async () => json({ data: [] }));
    const client = createMetaTemplateClient(options, fetcher as typeof fetch);
    await expect(client.list("https://attacker.example/bad")).rejects.toThrow();
    await expect(client.list("a".repeat(513))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authorizes only exact approved names and languages on the configured WABA", async () => {
    const fetcher = vi.fn(async () => json({ data: [
      { id: "t1", name: "appointment_reminder", language: "en_US", category: "UTILITY",
        status: "APPROVED", components: [{ type: "BODY", text: "Hello {{1}}" }] },
      { id: "t2", name: "appointment_reminder", language: "fr_FR", category: "UTILITY",
        status: "REJECTED", components: [{ type: "BODY", text: "Bonjour" }] },
      { id: "t3", name: "appointment_reminder", language: "es_ES", category: "AUTHENTICATION",
        status: "APPROVED", components: [{ type: "BODY", text: "Code" }] },
    ] }));
    const client = createMetaTemplateClient(options, fetcher as typeof fetch);
    await expect(client.approved("appointment_reminder", "en_US")).resolves.toMatchObject({
      status: "APPROVED", category: "UTILITY", body: "Hello {{1}}",
    });
    for (const language of ["fr_FR", "es_ES", "de_DE"]) {
      await expect(client.approved("appointment_reminder", language))
        .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_NOT_APPROVED" });
    }
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://graph.facebook.com/v22.0/123456789/message_templates?name=appointment_reminder&limit=100",
    );
    await expect(client.approved("../other-waba", "en_US")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects approved rich templates that need header or button components", async () => {
    const fetcher = vi.fn(async () => json({ data: [{
      id: "rich", name: "appointment_reminder", language: "en_US",
      status: "APPROVED", category: "UTILITY",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Appointment confirmed." },
      ],
    }] }));
    const client = createMetaTemplateClient(options, fetcher as typeof fetch);
    await expect(client.approved("appointment_reminder", "en_US"))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_UNSUPPORTED" });
    expect((await client.list()).items[0]).toMatchObject({ textOnly: false });
  });

  it("does not authorize a stale PENDING template or a Meta read failure", async () => {
    const pending = createMetaTemplateClient(options, vi.fn(async () => json({
      data: [{ id: "t", name: "appointment_reminder", language: "en_US",
        status: "PENDING", category: "UTILITY", components: [{ type: "BODY", text: "Hi" }] }],
    })) as typeof fetch);
    await expect(pending.approved("appointment_reminder", "en_US"))
      .rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_NOT_APPROVED" });
    const denied = createMetaTemplateClient(options, vi.fn(async () =>
      json({ error: { message: "Unavailable" } }, 403)) as typeof fetch);
    await expect(denied.approved("appointment_reminder", "en_US"))
      .rejects.toMatchObject({ status: 403 });
  });

  it("does not fabricate approval or hide Meta rejection and transport errors", async () => {
    const malformed = createMetaTemplateClient(options, vi.fn(async () => json({ id: "t" })) as typeof fetch);
    await expect(malformed.submit(valid)).rejects.toThrow();

    const denied = createMetaTemplateClient(options, vi.fn(async () =>
      json({ error: { message: "Permission denied" } }, 403)) as typeof fetch);
    await expect(denied.list()).rejects.toMatchObject({ status: 403 });
  });
});
