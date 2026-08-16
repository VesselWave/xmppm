import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync("apps/website/index.html", "utf8");
const css = readFileSync("apps/website/css/xmppm.css", "utf8");

describe("xmp.pm homepage capabilities", () => {
  test("shows a checkmarked capabilities list", () => {
    expect(html).toContain("<h2>Capabilities</h2>");
    expect(html).toContain('class="capabilities"');
    expect(html).toContain('aria-hidden="true" viewBox="0 0 16 16"');

    for (const capability of [
      "Multi-device message sync",
      "HTTP File Upload",
      "Offline message delivery",
      "Multi-user chat rooms",
      "OMEMO",
      "Audio/Video Call Support",
    ]) {
      expect(html).toContain(capability);
    }

    expect(html).not.toContain("Federated XMPP messaging");
    expect(html).not.toContain("TLS-protected client and server links");
  });

  test("styles capability checkmarks with the site palette", () => {
    expect(css).toContain(".capabilities");
    expect(css).toContain("color: var(--green)");
    expect(css).toContain("stroke: currentColor");
  });
});
