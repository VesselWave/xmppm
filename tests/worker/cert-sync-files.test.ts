import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const script = readFileSync("ops/vps/xmppm-ejabberd-cert-sync", "utf8");
const service = readFileSync("ops/systemd/xmppm-ejabberd-cert-sync.service", "utf8");
const timer = readFileSync("ops/systemd/xmppm-ejabberd-cert-sync.timer", "utf8");

describe("ejabberd certificate sync automation", () => {
  test("extracts all ejabberd service cert material from Traefik ACME storage", () => {
    expect(script).toContain("xmppm-gateway_traefik_letsencrypt");
    expect(script).toContain("required_names");
    expect(script).toContain("conference.xmp.pm");
    expect(script).toContain("pubsub.xmp.pm");
    expect(script).toContain("upload.xmp.pm");
    expect(script).toContain("base64.b64decode");
  });

  test("updates ejabberd certs safely and restarts ejabberd only on change", () => {
    expect(script).toContain("openssl x509");
    expect(script).toContain("cmp -s");
    expect(script).toContain("/var/lib/xmppm-agent/ejabberd-reason");
    expect(script).toContain("scheduled TLS certificate update");
    expect(script).toContain("systemctl restart ejabberd");
  });

  test("systemd runs sync daily and catches missed runs", () => {
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/usr/local/sbin/xmppm-ejabberd-cert-sync");
    expect(timer).toContain("OnCalendar=daily");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });
});
