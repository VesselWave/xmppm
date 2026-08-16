window.addEventListener("DOMContentLoaded", () => {
  converse.initialize({
    authentication: "login",
    auto_login: false,
    allow_registration: false,
    locked_domain: "xmp.pm",
    websocket_url: "wss://xmpp.xmp.pm/ws",
    bosh_service_url: "https://xmpp.xmp.pm/bosh",
    discover_connection_methods: false,
    assets_path: "/dist/",
    view_mode: "fullscreen",
    theme: "classic",
    dark_theme: "dracula",
  });
});
