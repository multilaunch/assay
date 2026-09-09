import { EXPLORER } from "../chain/config.js";
import type { EngineEvent } from "../engine/engine.js";
import { eth } from "../util/fmt.js";

/** Optional Telegram alerts. Silent and free when the two variables are unset. */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch { return false; }
}

export const telegramEnabled = (): boolean => !!process.env.TELEGRAM_BOT_TOKEN?.trim() && !!process.env.TELEGRAM_CHAT_ID?.trim();

export async function notify(e: EngineEvent): Promise<void> {
  if (!telegramEnabled()) return;
  if (e.kind === "fire") {
    await sendTelegram(`${e.live ? "FIRE" : "fire (dry)"} ${e.symbol}\n${eth(e.quoteIn)} ETH at tax ${(e.taxBps / 100).toFixed(2)}% after ${e.waitedMs} ms\n${EXPLORER.token(e.token)}`);
  } else if (e.kind === "exit") {
    await sendTelegram(`exit ${e.symbol}\n${eth(e.quoteOut)} out (${e.pnlPct >= 0 ? "+" : ""}${e.pnlPct.toFixed(1)}%) on ${e.venue}\n${e.reason}`);
  }
}
