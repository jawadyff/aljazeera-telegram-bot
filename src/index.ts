import { bot } from "./bot";
import { initDb } from "./db";
import { startListener } from "./listener";

async function main() {
  console.log("Starting Al Jazeera News Bot…");

  // 1. Init SQLite
  initDb();

  // 2. Start MTProto listener (handles interactive auth on first run)
  await startListener();

  // 4. Start Grammy bot (long-poll loop)
  await bot.start({
    allowed_updates: ["message", "channel_post"],
    onStart: (info) => {
      console.log(`Grammy bot running as @${info.username}`);
      console.log("Listening for group messages.");
    },
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down…");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});
