import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import input from "input";
import { config } from "./config";
import { addNewsContext } from "./claude-service";
import { insertMessage, getLatestMessageId } from "./db";

async function backfillLastWeek(client: TelegramClient): Promise<void> {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const channel = config.aljazeeraChannelId;
  let savedCount = 0;
  let offsetId = 0;
  const latestKnownId = getLatestMessageId(channel);

  console.log(`[Backfill] Fetching posts (latest in DB: #${latestKnownId})…`);

  while (true) {
    const batch = await client.getMessages(channel, {
      limit: 100,
      offsetId,
    });

    if (batch.length === 0) break;

    let reachedEnd = false;
    for (const msg of batch) {
      // Stop if we've gone past 1 week OR already have this message
      if ((msg.date as number) < oneWeekAgo) { reachedEnd = true; break; }
      if (msg.id <= latestKnownId) { reachedEnd = true; break; }
      if (!msg.text || msg.text.trim() === "") continue;
      insertMessage(msg.id, channel, msg.text, msg.date as number);
      savedCount++;
    }

    if (reachedEnd) break;
    offsetId = batch[batch.length - 1].id;
  }

  console.log(`[Backfill] Saved ${savedCount} new posts.`);
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

  // Resolve the channel to a numeric ID so the event filter works
  const entity = await client.getEntity(config.aljazeeraChannelId);
  const channelId = Number((entity as any).id);
  console.log(`[MTProto] Resolved ${config.aljazeeraChannelId} → numeric ID ${channelId}`);

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
    new NewMessage({ chats: [channelId] })
  );

  // Poll every 30s as a reliable fallback
  setInterval(async () => {
    try {
      const latestId = getLatestMessageId(config.aljazeeraChannelId);
      const batch = await client.getMessages(channel, { limit: 20 });
      let inserted = 0;
      for (const msg of batch) {
        if (msg.id <= latestId) break;
        if (!msg.text?.trim()) continue;
        insertMessage(msg.id, channel, msg.text, msg.date as number);
        addNewsContext(msg.text);
        inserted++;
        console.log(`[Poll] New post #${msg.id}: ${msg.text.slice(0, 80)}…`);
      }
    } catch (err) {
      console.error("[Poll] Error:", err);
    }
  }, 30_000);

  console.log("[MTProto] Listener running, watching:", config.aljazeeraChannelId);
  return client;
}
