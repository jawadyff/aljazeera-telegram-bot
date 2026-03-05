import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import input from "input";
import { config } from "./config";
import { addNewsContext } from "./claude-service";
import { insertMessage } from "./db";

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

  // On first run, print session string so user can save it to .env
  if (!config.telegramSession) {
    const sessionString = client.session.save() as unknown as string;
    console.log("\n[MTProto] Save this to your .env as TELEGRAM_SESSION:");
    console.log(`TELEGRAM_SESSION=${sessionString}\n`);
  }

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
