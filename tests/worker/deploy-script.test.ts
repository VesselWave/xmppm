import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const deployScript = readFileSync("ops/deploy.sh", "utf8");
const justfile = readFileSync("justfile", "utf8");
const vpsNginxConfig = readFileSync("ops/vps/xmppm-nginx.conf", "utf8");
const vpsCompose = readFileSync("ops/vps/gateway-docker-compose.yml", "utf8");
const vpsReadme = readFileSync("ops/vps/README.md", "utf8");
const ejabberdConfig = readFileSync("config/ejabberd.yml", "utf8");
const agentSudoers = readFileSync("ops/sudoers.d/xmppm-agent", "utf8");
const agentService = readFileSync("ops/systemd/xmppm-agent.service", "utf8");
const wranglerToml = readFileSync("wrangler.toml", "utf8");
const wranglerExampleToml = readFileSync("wrangler.toml.example", "utf8");
const smokeScriptPath = "ops/post-deploy-smoke.sh";
const smokeScript = existsSync(smokeScriptPath) ? readFileSync(smokeScriptPath, "utf8") : "";
const securityReviewScriptPath = "ops/dependency-security-review.sh";
const securityReviewScript = existsSync(securityReviewScriptPath)
  ? readFileSync(securityReviewScriptPath, "utf8")
  : "";
const reconcileScriptPath = "ops/reconcile-accounts.sh";
const reconcileScript = existsSync(reconcileScriptPath)
  ? readFileSync(reconcileScriptPath, "utf8")
  : "";

describe("deploy entrypoints", () => {
  test("justfile has explicit deploy targets and no deploying default", () => {
    expect(justfile).toContain("deploy:\n    @just --list | grep -E '^    deploy'");
    expect(justfile).toContain("deploy-worker:");
    expect(justfile).not.toContain("deploy-request:");
    expect(justfile).not.toContain("deploy-site:");
    expect(justfile).toContain("deploy-agent:");
    expect(justfile).toContain("deploy-proxy:");
    expect(justfile).toContain("deploy-vps:");
  });

  test("request deploy targets the Worker; VPS nginx only serves XMPP gateway", () => {
    expect(vpsNginxConfig).not.toContain("location = /request");
    expect(vpsNginxConfig).toContain("server_name xmpp.xmp.pm");
    expect(vpsNginxConfig).toContain("location = /healthz");
    expect(vpsNginxConfig).toContain("location /ws");
    expect(vpsNginxConfig).toContain("location /bosh");
    expect(vpsCompose).toContain("Host(`xmpp.xmp.pm`)");
    expect(vpsCompose).not.toContain("Host(`xmp.pm`)");
    expect(vpsCompose).not.toContain("/srv/www/xmp.pm");
    expect(justfile).not.toContain("deploy-request:");
    expect(justfile).toContain("ops/deploy.sh --only worker");
  });

  test("VPS gateway docs document local Traefik gateway and rollback", () => {
    expect(vpsReadme).toContain("$TARGET:$REMOTE_GATEWAY_DIR/docker-compose.yml");
    expect(vpsReadme).toContain("Traefik + `xmppm-worker-proxy`");
    expect(vpsReadme).toContain("Host(\\`xmpp.xmp.pm\\`)");
    expect(vpsReadme).toContain("ops/deploy.sh --only proxy");
    expect(vpsReadme).toContain("docker compose up -d");
  });

  test("VPS compose pins container image tags and documents update rollback", () => {
    expect(vpsCompose).not.toMatch(/image:\s*\S+:latest\b/);
    expect(vpsCompose).toContain("image: traefik:v3.6");
    expect(vpsCompose).toContain("image: nginx:1.30.3-alpine3.23-slim");
    expect(vpsReadme).toContain("Pinned image update procedure");
    expect(vpsReadme).toContain("docker compose pull");
    expect(vpsReadme).toContain("docker compose up -d");
  });

  test("Traefik requests SANs for ejabberd virtual-service certificate warnings", () => {
    expect(vpsCompose).toContain("traefik.http.routers.xmppm.tls.domains[0].main=xmpp.xmp.pm");
    expect(vpsCompose).toContain("conference.xmp.pm");
    expect(vpsCompose).toContain("pubsub.xmp.pm");
    expect(vpsCompose).toContain("upload.xmp.pm");
    expect(vpsCompose).not.toContain("mix.xmp.pm");
    expect(vpsCompose).not.toContain("proxy.xmp.pm");
  });

  test("dependency/security review cadence has an explicit runnable checklist", () => {
    expect(existsSync(securityReviewScriptPath)).toBe(true);
    expect(justfile).toContain("security-review:");
    expect(justfile).toContain("ops/dependency-security-review.sh");
    expect(securityReviewScript).toContain("bun outdated");
    expect(securityReviewScript).toContain("uv tree --outdated");
    expect(securityReviewScript).toContain("Review cadence");
  });

  test("account reconciliation report compares D1 invite state with ejabberd registered users", () => {
    expect(existsSync(reconcileScriptPath)).toBe(true);
    expect(justfile).toContain("reconcile-accounts:");
    expect(justfile).toContain("ops/reconcile-accounts.sh");
    expect(reconcileScript).toContain("wrangler d1 execute");
    expect(reconcileScript).toContain("registered_users");
    expect(reconcileScript).toContain("approved_pending_invite");
    expect(reconcileScript).toContain("invite_ready");
    expect(reconcileScript).toContain("registered_without_d1_record");
    expect(reconcileScript).toContain("invite_failed_but_registered");
    expect(reconcileScript).toContain("password_change_queue");
  });

  test("ejabberd enables required public XMPP services and disables ACME warnings", () => {
    expect(ejabberdConfig).toContain("acme:\n  auto: false");
    expect(ejabberdConfig).toContain("mod_proxy65: {}");
    expect(ejabberdConfig).not.toContain("mod_mix: {}");
    expect(ejabberdConfig).toContain("mod_muc:\n    host: \"conference.@HOST@\"");
    expect(ejabberdConfig).toContain("mod_http_upload:\n    host: \"upload.@HOST@\"");
  });

  test("agent sudoers permits account creation, password setting, and read-only Docker monitoring", () => {
    expect(agentSudoers).toContain("/usr/sbin/ejabberdctl register * xmp.pm *");
    expect(agentSudoers).toContain("/usr/sbin/ejabberdctl change_password * xmp.pm *");
    expect(agentSudoers).toContain("/usr/bin/docker inspect -f {{json .State}} xmppm-traefik");
    expect(agentSudoers).toContain("/usr/bin/docker inspect -f {{json .State}} xmppm-worker-proxy");
  });

  test("agent sudo privilege expansion is documented and bounded", () => {
    expect(agentService).toContain("NoNewPrivileges=false");
    expect(agentService).toContain("sudo needs privilege elevation for ejabberdctl and docker inspect");
    expect(agentService).toContain("NOPASSWD commands are bounded in ops/sudoers.d/xmppm-agent");
    expect(agentSudoers).not.toMatch(/NOPASSWD:\s*ALL/);
    expect(agentSudoers).not.toContain("/usr/sbin/ejabberdctl *");
    expect(agentSudoers).not.toContain("/usr/bin/docker *");
  });

  test("VPS deploy runs registration hardening smoke tests after ejabberd changes", () => {
    expect(deployScript).toContain("SKIP_REGISTRATION_SMOKE");
    expect(deployScript).toContain("run_registration_hardening_smoke");
    expect(deployScript).toContain("test_plain_xmpp_registration_without_invite_token_is_rejected");
    expect(deployScript).toContain("test_xmpp_registration_with_invite_token_is_accepted");
  });

  test("post-deploy smoke script validates public launch-gate endpoints", () => {
    expect(existsSync(smokeScriptPath)).toBe(true);
    expect(justfile).toContain("smoke:");
    expect(justfile).toContain("ops/post-deploy-smoke.sh");
    expect(justfile).toContain(smokeScriptPath);
    expect(smokeScript).toContain("https://xmp.pm/request");
    expect(smokeScript).toContain("https://xmp.pm/.well-known/host-meta");
    expect(smokeScript).toContain("https://xmp.pm/.well-known/host-meta.json");
    expect(smokeScript).toContain("https://xmpp.xmp.pm/healthz");
    expect(smokeScript).toContain("https://xmpp.xmp.pm/bosh");
    expect(smokeScript).toContain("https://xmpp.xmp.pm/ws");
    expect(smokeScript).toContain("--fail");
  });

  test("committed Wrangler config keeps operator IP bypasses out of public config", () => {
    expect(wranglerToml).not.toMatch(/RATE_LIMIT_BYPASS_IPS\s*=\s*"[^\"]+"/);
    expect(wranglerToml).not.toMatch(/TRUSTED_FORM_IPS\s*=\s*"[^\"]+"/);
    expect(wranglerExampleToml).toContain("RATE_LIMIT_BYPASS_IPS");
    expect(wranglerExampleToml).toContain("TRUSTED_FORM_IPS");
    expect(wranglerExampleToml).toContain("set these as environment-specific secrets/vars");
  });

  test("bare deploy skips the Worker by default", () => {
    expect(deployScript).toContain("RESET=0\nONLY=vps");
    expect(deployScript).not.toContain("--skip-worker");
  });

  test("agent deploy is isolated and cannot reset state", () => {
    expect(justfile).toContain("ops/deploy.sh --only agent");
    expect(justfile).not.toContain("deploy-agent reset");
    expect(deployScript).toContain("--only all|worker|vps|agent|proxy");
    expect(deployScript).toContain('RESET is only allowed with --only all, worker, or vps');
  });

  test("agent deploy preserves existing browser encryption key", () => {
    expect(deployScript).toContain("if ! sudo test -f /var/lib/xmppm-agent/private_key.pem; then");
  });

  test("VPS deploy opens XEP-0368 direct TLS and advertised TURN TLS ports", () => {
    expect(deployScript).toContain('ufw allow 5223/tcp comment \'xmppm XEP-0368 c2s direct TLS\'');
    expect(deployScript).toContain('ufw allow 5270/tcp comment \'xmppm XEP-0368 s2s direct TLS\'');
    expect(deployScript).toContain('ufw allow 5349/tcp comment \'xmppm STUN/TURN TLS\'');
  });

  test("VPS deploy does not advertise IPv6 TURN when Oracle has no public IPv6", () => {
    expect(deployScript).not.toContain("PUBLIC_IPV6=::1");
    expect(deployScript).toContain("if ipv6:");
    expect(deployScript).toContain("turn_ipv6_address: VPS_IPV6_ADDRESS");
    expect(deployScript).toContain("not in line");
  });

  test("VPS deploy removes stale public ejabberd HTTP firewall openings", () => {
    for (const port of [5280, 5281, 5443]) {
      expect(deployScript).toContain(`ufw delete allow ${port}/tcp`);
    }
  });

  test("VPS deploy patches and installs PubSub serverinfo contrib module", () => {
    expect(deployScript).toContain("modules_update_specs");
    expect(deployScript).toContain("mod_pubsub_serverinfo.erl");
    expect(deployScript).toContain("module_install mod_pubsub_serverinfo");
  });

});

describe("deploy script SSL backups", () => {
  test("backs up VPS SSL material before destructive remote deployment", () => {
    expect(deployScript).toContain("SSL_BACKUP_DIR");
    expect(deployScript).toContain("SKIP_SSL_BACKUP");
    expect(deployScript).toContain("/etc/ssl/certs/ejabberd");
    expect(deployScript).toContain("/etc/ssl/private/ejabberd");
    expect(deployScript).toContain("acme.json");

    const backupIndex = deployScript.indexOf("backup_ssl_certs");
    const rsyncIndex = deployScript.indexOf('rsync "${rsync_args[@]}"');
    expect(backupIndex).toBeGreaterThan(-1);
    expect(rsyncIndex).toBeGreaterThan(-1);
    expect(backupIndex).toBeLessThan(rsyncIndex);
  });

  test("installs automated ejabberd TLS renewal propagation after Traefik SAN labels are deployed", () => {
    expect(deployScript).toContain("xmppm-ejabberd-cert-sync");
    expect(deployScript).toContain("systemctl enable --now xmppm-ejabberd-cert-sync.timer");
    expect(deployScript).toContain("run_cert_sync_with_retry");

    const proxyIndex = deployScript.indexOf("deploy_proxy");
    const syncIndex = deployScript.indexOf("run_cert_sync_with_retry");
    expect(proxyIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(proxyIndex);
  });
});

describe("VPS worker proxy headers", () => {
  test("does not forward client-controlled forwarded-for into trusted invite bypass", () => {
    expect(vpsNginxConfig).not.toContain("proxy_set_header X-Original-Forwarded-For $http_x_forwarded_for;");
  });

  test("deploy rsync excludes local secret files", () => {
    expect(deployScript).toContain("--exclude '.env'");
    expect(deployScript).toContain("--exclude '.env.*'");
    expect(deployScript).toContain("--exclude '.dev.vars'");
    expect(deployScript).toContain("--exclude '*.pem'");
    expect(deployScript).toContain("rsync_args+=(apps/agent/");
    expect(deployScript).toContain("ops/vps/gateway-docker-compose.yml");
  });

  test("starts proxy after copying nginx config", () => {
    const copyIndex = deployScript.indexOf("cp \"$REMOTE_RELEASE/ops/vps/xmppm-nginx.conf\" ./xmppm-nginx.conf");
    const upIndex = deployScript.indexOf("sudo docker compose up -d");
    expect(copyIndex).toBeGreaterThan(-1);
    expect(upIndex).toBeGreaterThan(-1);
    expect(upIndex).toBeGreaterThan(copyIndex);
  });

  test("proxies XMPP HTTP upload through the standard TLS gateway", () => {
    expect(ejabberdConfig).toContain('put_url: "https://xmpp.xmp.pm/upload"');
    expect(vpsNginxConfig).toContain("location /upload");
    expect(vpsNginxConfig).toContain("client_max_body_size 110m;");
    expect(vpsNginxConfig).toContain("proxy_pass https://host.docker.internal:5443/upload");
    expect(deployScript).toContain("sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT");
    expect(deployScript).toContain("install -d -o ejabberd -g ejabberd -m 0750 /opt/ejabberd/upload");
  });

  test("raw ejabberd HTTP gateway ports bind only to the Docker bridge", () => {
    for (const port of [5280, 5281, 5443]) {
      const portIndex = ejabberdConfig.indexOf(`port: ${port}`);
      expect(portIndex).toBeGreaterThan(-1);
      const nextListenerIndex = ejabberdConfig.indexOf("\n  -\n", portIndex + 1);
      const listenerBlock = ejabberdConfig.slice(
        portIndex,
        nextListenerIndex === -1 ? undefined : nextListenerIndex,
      );

      expect(listenerBlock).toContain('ip: "172.17.0.1"');
      expect(listenerBlock).not.toContain('ip: "::"');
    }
  });
});
