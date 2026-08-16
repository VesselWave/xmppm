import { describe, expect, it } from "bun:test";
import { buildAdminMessage, parseCallbackData } from "../../apps/worker/telegram";

describe("telegram helpers", () => {
  it("builds callback data", () => {
    expect(parseCallbackData("invite:approve:req_123")).toEqual({
      kind: "invite",
      action: "approve",
      requestId: "req_123",
    });
  });

  it("parses retry callback data", () => {
    expect(parseCallbackData("invite:retry:req_123")).toEqual({
      kind: "invite",
      action: "retry",
      requestId: "req_123",
    });
  });

  it("rejects unrelated callback data", () => {
    expect(parseCallbackData("other")).toBeNull();
  });

  it("includes username in admin message", () => {
    const message = buildAdminMessage({
      id: "r1",
      desiredUsername: "alice",
      message: "hello",
      contact: "@alice",
      statusUrl: "https://xmp.pm/status/s",
    });
    expect(message).toContain("alice");
    expect(message).toContain("@alice");
  });
});
