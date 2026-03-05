import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import input from "input";
import { config } from "./config";
import { addNewsContext } from "./claude-service";
import { insertMessage } from "./db";

async function backfillLastWeek(client: TelegramClient): Promise<void> {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const channel = config.aljazeeraChannelId;
  let savedCount = 0;
  let offsetId = 0;

  console.log("[Backfill] Fetching last week of AJENews posts…");

  while (true) {
    const batch = await client.getMessages(channel, {
      limit: 100,
      offsetId,
    });

    if (batch.length === 0) break;

    let reachedEnd = false;
    for (const msg of batch) {
      if ((msg.date as number) < oneWeekAgo) { reachedEnd = true; break; }
      if (!msg.text || msg.text.trim() === "") continue;
      insertMessage(msg.id, channel, msg.text, msg.date as number);
      savedCount++;
    }

    if (reachedEnd) break;
    offsetId = batch[batch.length - 1].id;
  }

  console.log(`[Backfill] Saved ${savedCount} posts from the last week.`);
}

export async function startListener(): Promise<TelegramClient> {
  const session = new StringSession(config.telegramSession);

  const client = new TelegramClient(
    session,
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => await input.text("Enter your phone number: "),
    password: async () => await input.text("Enter your 2FA password: "),
    phoneCode: async () => await input.text("Enter the Telegram code: "),
    onError: (err) => console.error("[MTProto] Auth error:", err),
  });

  // Backfill last week's messages (INSERT OR IGNORE means safe to re-run)
  await backfillLastWeek(client);

  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const message = event.message;
      const text = message.text;
      if (!text || text.trim() === "") return;

      const messageId = message.id;
      const date = message.date as number;
      const channel = config.aljazeeraChannelId;

      insertMessage(messageId, channel, text, date);
      addNewsContext(text);

      console.log(`[MTProto] New post #${messageId}: ${text.slice(0, 80)}…`);
    },
    new NewMessage({ chats: [config.aljazeeraChannelId] })
  );

  console.log("[MTProto] Listener running, watching:", config.aljazeeraChannelId);
  return client;
}
