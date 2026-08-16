import { describe, expect, it } from "bun:test";
import {
  adminUserAllowed,
  createId,
  hashSecret,
  normalizeUsername,
  safeSummary,
} from "../../apps/worker/security";

describe("security helpers", () => {
  it("normalizes valid usernames", () => {
    expect(normalizeUsername(" Alice_123 ")).toBe("alice_123");
  });

  it("rejects invalid usernames", () => {
    expect(() => normalizeUsername("bad name")).toThrow("Invalid username");
    expect(() => normalizeUsername("admin@xmp.pm")).toThrow("Invalid username");
  });

  it("hashes secrets without returning the raw secret", async () => {
    const hash = await hashSecret("abc");
    expect(hash).not.toBe("abc");
    expect(hash.length).toBeGreaterThan(20);
  });

  it("creates URL-safe IDs", () => {
    expect(createId(16)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("checks admin allowlist", () => {
    expect(adminUserAllowed("1,2,3", 2)).toBe(true);
    expect(adminUserAllowed("1,2,3", 4)).toBe(false);
  });

  it("summarizes long errors", () => {
    expect(safeSummary("x".repeat(500), 20)).toHaveLength(20);
  });
});
