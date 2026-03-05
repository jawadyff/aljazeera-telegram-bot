import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  claudeApiKey: requireEnv("ANTHROPIC_API_KEY"),
  aljazeeraChannelId: process.env.ALJAZEERA_CHANNEL_ID || "AJENews",
  allowedGroupIds: process.env.ALLOWED_GROUP_IDS
    ? process.env.ALLOWED_GROUP_IDS.split(",").map((id) => id.trim())
    : [],
  adminUserId: process.env.ADMIN_USER_ID
    ? Number(process.env.ADMIN_USER_ID)
    : null,
  telegramApiId: Number(requireEnv("TELEGRAM_API_ID")),
  telegramApiHash: requireEnv("TELEGRAM_API_HASH"),
  telegramSession: process.env.TELEGRAM_SESSION ?? "",
};
