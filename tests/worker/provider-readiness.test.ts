import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

describe("XMPP Providers readiness pages", () => {
  it("publishes legal notice and does not advertise password reset", () => {
    const legalPath = "apps/website/legal.html";
    const passwordPath = "apps/website/password.html";

    expect(existsSync(legalPath)).toBe(true);
    expect(existsSync(passwordPath)).toBe(false);

    const legal = readFileSync(legalPath, "utf8");
    expect(legal).toContain("admin@xmp.pm");
    expect(legal).toContain("vesselwave@protonmail.com");
    expect(legal).toContain("Volunteer-run");
    expect(legal).toContain("No SLA");
  });

  it("publishes provider metadata accepted by XMPP Providers", () => {
    const provider = JSON.parse(readFileSync("apps/website/.well-known/xmpp-provider-v2.json", "utf8")) as {
      website: { en: string };
      alternativeJids: string[];
      busFactor: number;
      organization: string;
      passwordReset: Record<string, never>;
      serverTesting: boolean;
      maximumHttpFileUploadTotalSize: number;
      maximumHttpFileUploadStorageTime: number;
      maximumMessageArchiveManagementStorageTime: number;
      professionalHosting: boolean;
      freeOfCharge: boolean;
      legalNotice: { en: string };
      serverLocations: string[];
      since: string;
    };

    expect(provider).toEqual({
      website: { en: "https://xmp.pm/" },
      alternativeJids: [],
      busFactor: 1,
      organization: "private person",
      passwordReset: {},
      serverTesting: true,
      maximumHttpFileUploadTotalSize: 105,
      maximumHttpFileUploadStorageTime: 7,
      maximumMessageArchiveManagementStorageTime: 7,
      professionalHosting: true,
      freeOfCharge: true,
      legalNotice: { en: "https://xmp.pm/legal.html" },
      serverLocations: ["ch"],
      since: "2026-06-14",
    });
  });

  it("keeps total upload quota at least as high as the per-file upload limit", () => {
    const provider = JSON.parse(readFileSync("apps/website/.well-known/xmpp-provider-v2.json", "utf8")) as {
      maximumHttpFileUploadTotalSize: number;
    };
    const ejabberd = readFileSync("config/ejabberd.yml", "utf8");
    const maxSizeBytes = Number(ejabberd.match(/max_size: (\d+) # 100 MiB per file/)?.[1]);
    const maximumHttpFileUploadFileSizeMb = Math.ceil(maxSizeBytes / 1_000_000);

    expect(provider.maximumHttpFileUploadTotalSize).toBeGreaterThanOrEqual(maximumHttpFileUploadFileSizeMb);
  });

  it("links only relevant provider readiness pages from info and homepage", () => {
    const info = readFileSync("apps/website/info.html", "utf8");
    expect(info).toContain("private person");
    expect(info).toContain("Bus factor: 1");
    expect(info).toContain("Switzerland");
    expect(info).toContain("2026-06-14");
    expect(info).toContain("Automated XMPP provider checks");
    expect(info).toContain("100 MiB per file");
    expect(info).toContain("legal.html");
    expect(info).not.toContain("password.html");
    expect(info).not.toContain("Password reset");

    const homepage = readFileSync("apps/website/index.html", "utf8");
    expect(homepage).toContain("info.html");
    expect(homepage).toContain("legal.html");
    expect(homepage).not.toContain("password.html");
    expect(homepage).not.toContain("Password reset");
  });
});
