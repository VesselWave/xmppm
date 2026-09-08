(() => {
  function refresh(panel) {
    const url = panel.getAttribute("data-refresh-url") || window.location.href;
    window.location.href = url;
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-refresh-seconds][data-refresh-url]").forEach((panel) => {
      const button = panel.querySelector("[data-refresh-now]");
      if (button) button.addEventListener("click", () => refresh(panel));

      const seconds = Number(panel.getAttribute("data-refresh-seconds"));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 7000;
      setTimeout(() => refresh(panel), delay);
    });
  });
})();
