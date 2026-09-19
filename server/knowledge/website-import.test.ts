import { describe, expect, it } from "vitest";
import { htmlToKnowledgeText, isPublicAddress } from "./website-import";

describe("website knowledge import safety", () => {
  it("rejects private and local IP address ranges", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.5")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("192.168.1.12")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("2001:0db8:1::1")).toBe(false);
    expect(isPublicAddress("2002:0a00:0001::")).toBe(false);
    expect(isPublicAddress("2001:0::1")).toBe(false);
  });

  it("allows ordinary public addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("strips scripts and HTML markup before storing website knowledge", () => {
    const text = htmlToKnowledgeText("<h1>Pricing &amp; Services</h1><script>ignore()</script><p>Repairs from $99</p>");
    expect(text).toContain("Pricing & Services");
    expect(text).toContain("Repairs from $99");
    expect(text).not.toContain("ignore()");
    expect(text).not.toContain("<h1>");
  });
});
