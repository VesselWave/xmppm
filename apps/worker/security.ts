export function createId(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeUsername(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]$/.test(value)) {
    throw new Error("Invalid username");
  }
  return value;
}

export function adminUserAllowed(csv: string, userId: number): boolean {
  return csv
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(String(userId));
}

export function safeSummary(value: string, maxLength = 300): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  return clean.length <= maxLength ? clean : clean.slice(0, maxLength);
}

export function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function verifyTurnstile(
  secretKey: string,
  token: string,
  remoteIp: string | null
): Promise<boolean> {
  try {
    const form = new FormData();
    form.append("secret", secretKey);
    form.append("response", token);
    if (remoteIp) form.append("remoteip", remoteIp);

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
