import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const html = readFileSync("apps/website/conversejs.html", "utf8");
const init = readFileSync("apps/website/js/converse-init.js", "utf8");
const nordDark = readFileSync("apps/website/css/converse-nord-dark.css", "utf8");
const manifest = JSON.parse(readFileSync("apps/website/dist/manifest.json", "utf8")) as {
  version?: string;
};
const downloadedVersion = readFileSync("apps/website/dist/VERSION", "utf8").trim();

test("ships and initializes the Converse web client", () => {
  expect(downloadedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.version).toBe(downloadedVersion);
  expect(html).toContain('href="/dist/converse.min.css"');
  expect(html).toContain('href="/css/converse-nord-dark.css"');
  expect(html).toContain('<script type="module" src="/dist/converse.min.js"></script>');
  expect(html).toContain('<script type="module" src="/js/converse-init.js"></script>');
  expect(html).not.toContain("converse.initialize");
  expect(init).toContain('websocket_url: "wss://xmpp.xmp.pm/ws"');
  expect(init).toContain('bosh_service_url: "https://xmpp.xmp.pm/bosh"');
  expect(init).toContain('locked_domain: "xmp.pm"');
  expect(init).toContain("converse.initialize");
  expect(init).toContain('theme: "classic"');
  expect(init).toContain('dark_theme: "dracula"');
  expect(nordDark).toContain("--background-color: #2e3440");
  expect(nordDark).toContain("--foreground-color: #e5e9f0");
  expect(nordDark).toContain("--primary-color: #88c0d0");
  expect(html).not.toContain("Browser chat is not currently offered here.");
});

test("self-hosts login sponsor images", () => {
  const bundle = readFileSync("apps/website/dist/converse.min.js", "utf8");
  expect(bundle).not.toContain("https://conversejs.org/media/logos/");
  for (const filename of [
    "bairesdev-dark.png",
    "BairesDev_logo-orange.png",
    "blokt-invert.png",
    "blokt.png",
    "litslink-dark.svg",
    "litslink-light.svg",
  ]) {
    expect(bundle).toContain(`/dist/images/sponsors/${filename}`);
    expect(existsSync(`apps/website/dist/images/sponsors/${filename}`)).toBe(true);
  }
});
