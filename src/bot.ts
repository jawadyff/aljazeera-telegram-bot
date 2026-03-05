import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config";
import {
  analyzeQuestion,
  addNewsContext,
  generateNewsSummary,
} from "./claude-service";

export const bot = new Bot(config.telegramToken);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAllowedChat(chatId: number, chatType: string): boolean {
  // DMs with the bot are always allowed
  if (chatType === "private") return true;
  // If no allowlist is configured, allow all groups
  if (config.allowedGroupIds.length === 0) return true;
  return config.allowedGroupIds.includes(String(chatId));
}

/** Split a long message into ≤4096-char chunks and send them sequentially. */
async function sendLongMessage(
  ctx: Parameters<typeof bot.api.sendMessage>[0] extends number | string
    ? never
    : any,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  const chunks = text.match(/[\s\S]{1,4096}/g) ?? [text];
  for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(chunks[i], {
      reply_to_message_id: i === 0 ? replyToMessageId : undefined,
      parse_mode: "Markdown",
    });
  }
}

// ─── Channel post handler ────────────────────────────────────────────────────

/**
 * When the bot is added to the Al Jazeera channel (or forwarded posts arrive),
 * it captures the text to use as grounding context for user questions.
 */
bot.on("channel_post", async (ctx) => {
  const post = ctx.channelPost;
  const text = post.text ?? post.caption;
  if (!text) return;

  // Store for context (fire-and-forget, no reply needed in channels)
  addNewsContext(text);
  console.log(
    `[Channel] Captured post (${text.length} chars): ${text.slice(0, 80)}…`
  );
});

// ─── Group / private message handlers ───────────────────────────────────────

/** /start — welcome message */
bot.command("start", async (ctx) => {
  if (!isAllowedChat(ctx.chat.id, ctx.chat.type)) return;

  await ctx.reply(
    "👋 *Al Jazeera News Analyst Bot*\n\n" +
      "I read Al Jazeera channel posts and answer your questions using Claude Opus.\n\n" +
      "*Commands:*\n" +
      "/ask <question> — Ask a question about the news\n" +
      "/digest — Get a summary of recent AJ posts\n" +
      "/help — Show this message\n\n" +
      "Or just ask me any question directly!",
    { parse_mode: "Markdown" }
  );
});

/** /help */
bot.command("help", async (ctx) => {
  if (!isAllowedChat(ctx.chat.id, ctx.chat.type)) return;
  await ctx.reply(
    "*How to use this bot:*\n\n" +
      "• `/ask <your question>` — Ask anything about current news\n" +
      "• `/digest` — Get a brief summary of recent Al Jazeera posts\n" +
      "• Reply to any of my messages with a follow-up question\n" +
      "• In private chat you can just type naturally\n\n" +
      "_Powered by Claude Opus 4 · Al Jazeera English_",
    { parse_mode: "Markdown" }
  );
});

/** /ask <question> — explicit question command */
bot.command("ask", async (ctx) => {
  if (!isAllowedChat(ctx.chat.id, ctx.chat.type)) return;

  const question = ctx.match?.trim();
  if (!question) {
    await ctx.reply("Please provide a question, e.g. `/ask What happened in Gaza today?`", {
      parse_mode: "Markdown",
    });
    return;
  }

  await ctx.replyWithChatAction("typing");

  try {
    const answer = await analyzeQuestion(question);
    await sendLongMessage(ctx, answer, ctx.message?.message_id);
  } catch (err) {
    console.error("[/ask] Claude error:", err);
    await ctx.reply("⚠️ Sorry, I couldn't process your question. Please try again.");
  }
});

/** /digest — summarize recent channel posts */
bot.command("digest", async (ctx) => {
  if (!isAllowedChat(ctx.chat.id, ctx.chat.type)) return;

  await ctx.replyWithChatAction("typing");

  try {
    const summary = await generateNewsSummary();
    await sendLongMessage(ctx, `*📰 Al Jazeera News Digest*\n\n${summary}`, ctx.message?.message_id);
  } catch (err) {
    console.error("[/digest] Error:", err);
    await ctx.reply("⚠️ Couldn't generate digest. Please try again later.");
  }
});

// ─── Free-text message handler ───────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  if (!isAllowedChat(ctx.chat.id, ctx.chat.type)) return;

  const text = ctx.message.text;

  // Ignore commands (already handled above)
  if (text.startsWith("/")) return;

  const isPrivate = ctx.chat.type === "private";
  const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
  const isMentioned = ctx.entities("mention").some(
    (e) => text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${ctx.me.username?.toLowerCase()}`
  );
  const looksLikeQuestion =
    text.includes("?") ||
    /^(what|who|when|where|why|how|is|are|was|were|did|do|does|can|could|would|should)\b/i.test(text);

  // In groups: respond to questions, @mentions, or replies to the bot
  if (!isPrivate && !isReplyToBot && !isMentioned && !looksLikeQuestion) return;

  await ctx.replyWithChatAction("typing");

  try {
    const answer = await analyzeQuestion(text);
    await sendLongMessage(ctx, answer, ctx.message.message_id);
  } catch (err) {
    console.error("[message] Claude error:", err);
    await ctx.reply("⚠️ Sorry, I couldn't process your message. Please try again.");
  }
});

// ─── Global error handler ────────────────────────────────────────────────────

bot.catch((err) => {
  console.error("[Bot error]", err.error);
});
