(() => {
  async function encryptPassword(password) {
    const res = await fetch("/agent-pubkey.pem");
    if (!res.ok) throw new Error("Failed to load cryptographic key.");
    const pem = await res.text();
    const cleanPem = pem
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s/g, "");
    const binaryDerString = window.atob(cleanPem);
    const binaryDer = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) {
      binaryDer[i] = binaryDerString.charCodeAt(i);
    }
    const publicKey = await crypto.subtle.importKey(
      "spki",
      binaryDer.buffer,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"]
    );
    const msgBuffer = new TextEncoder().encode(password);
    const ciphertextBuffer = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, msgBuffer);
    const ciphertextBytes = new Uint8Array(ciphertextBuffer);
    let binary = "";
    for (let i = 0; i < ciphertextBytes.byteLength; i++) {
      binary += String.fromCharCode(ciphertextBytes[i]);
    }
    return window.btoa(binary);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("password-form");
    const input = document.getElementById("password-input");
    const btn = document.getElementById("submit-btn");
    const state = document.getElementById("password-state");
    if (!form || !input || !btn || !state) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = input.value;
      if (password.length < 12 || password.length > 200) return;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = "Securing locally…";
      state.textContent = "Securing in this browser, then queueing password setup.";
      try {
        input.maxLength = 1000;
        input.value = await encryptPassword(password);
        state.textContent = "Sending encrypted password to the setup queue…";
        form.submit();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        alert("Password setup failed: " + message);
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.textContent = "Set password";
        state.textContent = "Setup did not start. Check connection and try again.";
      }
    });
  });
})();
