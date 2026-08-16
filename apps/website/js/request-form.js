(() => {
  let submitBtn = null;
  let state = null;
  let form = null;

  function enableSubmit() {
    if (!submitBtn || !state) return;
    submitBtn.disabled = false;
    submitBtn.setAttribute("aria-disabled", "false");
    state.textContent = "";
  }

  function disableSubmit() {
    if (!submitBtn || !state) return;
    submitBtn.disabled = true;
    submitBtn.setAttribute("aria-disabled", "true");
    state.textContent = "Complete Turnstile to enable submit.";
  }

  window.onTurnstileSuccess = enableSubmit;
  window.onTurnstileUnavailable = disableSubmit;

  document.addEventListener("DOMContentLoaded", () => {
    submitBtn = document.getElementById("request-submit");
    state = document.getElementById("turnstile-state");
    form = document.getElementById("request-form");
    if (!form) return;

    form.addEventListener("submit", (event) => {
      const token = form.querySelector('[name="cf-turnstile-response"]');
      if (!token || !token.value) {
        event.preventDefault();
        disableSubmit();
      }
    });

    disableSubmit();
  });
})();
