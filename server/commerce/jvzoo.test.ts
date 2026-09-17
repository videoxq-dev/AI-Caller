import { describe, expect, it } from "vitest";
import { calculateJvzooVerify } from "./jvzoo";

describe("JVZoo cverify", () => {
  it("matches the documented sorted-field SHA-1 verification model", () => {
    const payload = {
      ccustemail: "buyer@example.com",
      cproditem: "123",
      ctransaction: "SALE",
      ctransreceipt: "R-1",
      cverify: "ignored-when-calculating",
    };
    expect(calculateJvzooVerify(payload, "secret")).toBe("CD1225F3");
  });

  it("is independent of object insertion order", () => {
    const one = { cproditem: "123", ccustemail: "buyer@example.com", ctransreceipt: "R-1", ctransaction: "SALE" };
    const two = { ctransaction: "SALE", ctransreceipt: "R-1", ccustemail: "buyer@example.com", cproditem: "123" };
    expect(calculateJvzooVerify(one, "secret")).toBe(calculateJvzooVerify(two, "secret"));
  });
});
