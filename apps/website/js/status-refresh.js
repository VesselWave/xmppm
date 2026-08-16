(() => {
  function refresh(panel) {
    const url = panel.getAttribute("data-refresh-url") || window.location.href;
    window.location.href = url;
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-refresh-minutes][data-refresh-key][data-refresh-url]").forEach((panel) => {
      const button = panel.querySelector("[data-refresh-now]");
      if (button) button.addEventListener("click", () => refresh(panel));

      const key = panel.getAttribute("data-refresh-key") || "xmppm_status_refresh";
      const attemptKey = key + ":attempt";
      const attempt = Number(sessionStorage.getItem(attemptKey) || "0");
      sessionStorage.setItem(attemptKey, String(attempt + 1));
      const delay = Math.min(60000, 7000 * 2 ** attempt);
      setTimeout(() => refresh(panel), delay);
    });
  });
})();
