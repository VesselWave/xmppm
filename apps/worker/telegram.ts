import type { Env } from "./types";
import { htmlEscape } from "./security";

export type ParsedCallback = {
  kind: "invite";
  action: "approve" | "deny" | "retry";
  requestId: string;
};

export function parseCallbackData(data: string): ParsedCallback | null {
  const match = data.match(/^invite:(approve|deny|retry):([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const action = match[1];
  const requestId = match[2];
  if (!requestId) return null;
  return {
    kind: "invite",
    action: action as "approve" | "deny" | "retry",
    requestId,
  };
}

export function buildAdminMessage(input: {
  id: string;
  desiredUsername: string;
  message: string;
  contact: string | null;
  statusUrl: string;
}): string {
  const contact = input.contact ? htmlEscape(input.contact) : "not provided";
  return [
    "<b>New xmp.pm invite request</b>",
    `ID: <code>${htmlEscape(input.id)}</code>`,
    `Username: <code>${htmlEscape(input.desiredUsername)}</code>`,
    `Contact: ${contact}`,
    `Status: <code>${htmlEscape(input.statusUrl)}</code>`,
    "",
    htmlEscape(input.message),
  ].join("\n");
}

export async function sendInviteRequestMessage(
  env: Env,
  input: {
    requestId: string;
    desiredUsername: string;
    message: string;
    contact: string | null;
    statusUrl: string;
  }
): Promise<string> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text: buildAdminMessage({
        id: input.requestId,
        desiredUsername: input.desiredUsername,
        message: input.message,
        contact: input.contact,
        statusUrl: input.statusUrl,
      }),
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `invite:approve:${input.requestId}` },
          { text: "❌ Deny", callback_data: `invite:deny:${input.requestId}` },
        ]],
      },
    }),
  });
  const data = (await response.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
  if (!data.ok || !data.result) {
    throw new Error(data.description ?? "Telegram sendMessage failed");
  }
  return String(data.result.message_id);
}

export async function answerCallback(env: Env, callbackQueryId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function sendInviteFailedMessage(
  env: Env,
  input: {
    requestId: string;
    desiredUsername: string;
    error: string;
    telegramMessageId: string | null;
  }
): Promise<void> {
  const text = [
    `⚠️ <b>Invite generation failed</b>`,
    `ID: <code>${htmlEscape(input.requestId)}</code>`,
    `Username: <code>${htmlEscape(input.desiredUsername)}</code>`,
    `Error: <code>${htmlEscape(input.error)}</code>`,
  ].join("\n");

  const makeBody = (replyId: number | null) => {
    const body: Record<string, any> = {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: "🔁 Retry", callback_data: `invite:retry:${input.requestId}` },
        ]],
      },
    };
    if (replyId !== null) {
      body.reply_to_message_id = replyId;
    }
    return body;
  };

  const attemptSend = async (replyId: number | null): Promise<boolean> => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody(replyId)),
      });
      const data = (await response.json()) as { ok: boolean; description?: string };
      if (data.ok) {
        return true;
      }
      if (replyId !== null && data.description?.includes("reply message not found")) {
        return false;
      }
      throw new Error(data.description ?? "Telegram sendMessage failed");
    } catch (err) {
      if (replyId !== null) {
        return false;
      }
      throw err;
    }
  };

  const replyId = input.telegramMessageId ? Number(input.telegramMessageId) : null;
  if (replyId !== null && !isNaN(replyId)) {
    const success = await attemptSend(replyId);
    if (success) return;
  }
  await attemptSend(null);
}

export async function sendPasswordQueuedMessage(
  env: Env,
  input: {
    requestId: string;
    desiredUsername: string;
    telegramMessageId: string | null;
  }
): Promise<void> {
  const text = [
    `🔑 <b>Password setup queued</b>`,
    `ID: <code>${htmlEscape(input.requestId)}</code>`,
    `Username: <code>${htmlEscape(input.desiredUsername)}</code>`,
  ].join("\n");

  const makeBody = (replyId: number | null) => {
    const body: Record<string, any> = {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text,
    };
    if (replyId !== null) {
      body.reply_to_message_id = replyId;
    }
    return body;
  };

  const attemptSend = async (replyId: number | null): Promise<boolean> => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody(replyId)),
      });
      const data = (await response.json()) as { ok: boolean; description?: string };
      if (data.ok) return true;
      if (replyId !== null && data.description?.includes("reply message not found")) {
        return false;
      }
      throw new Error(data.description ?? "Telegram sendMessage failed");
    } catch (err) {
      if (replyId !== null) return false;
      throw err;
    }
  };

  const replyId = input.telegramMessageId ? Number(input.telegramMessageId) : null;
  if (replyId !== null && !isNaN(replyId)) {
    const success = await attemptSend(replyId);
    if (success) return;
  }
  await attemptSend(null);
}

export async function sendPasswordCompleteMessage(
  env: Env,
  input: {
    requestId: string;
    desiredUsername: string;
    telegramMessageId: string | null;
  }
): Promise<void> {
  const text = [
    `✅ <b>Password setup completed</b>`,
    `ID: <code>${htmlEscape(input.requestId)}</code>`,
    `Username: <code>${htmlEscape(input.desiredUsername)}</code>`,
  ].join("\n");

  const makeBody = (replyId: number | null) => {
    const body: Record<string, any> = {
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text,
    };
    if (replyId !== null) {
      body.reply_to_message_id = replyId;
    }
    return body;
  };

  const attemptSend = async (replyId: number | null): Promise<boolean> => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody(replyId)),
      });
      const data = (await response.json()) as { ok: boolean; description?: string };
      if (data.ok) return true;
      if (replyId !== null && data.description?.includes("reply message not found")) {
        return false;
      }
      throw new Error(data.description ?? "Telegram sendMessage failed");
    } catch (err) {
      if (replyId !== null) return false;
      throw err;
    }
  };

  const replyId = input.telegramMessageId ? Number(input.telegramMessageId) : null;
  if (replyId !== null && !isNaN(replyId)) {
    const success = await attemptSend(replyId);
    if (success) return;
  }
  await attemptSend(null);
}
