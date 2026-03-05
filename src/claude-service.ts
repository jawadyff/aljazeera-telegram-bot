import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { getRecentMessages, getMessagesByTimeRange, searchMessages } from "./db";

const client = new Anthropic({ apiKey: config.claudeApiKey });

// Rolling window of recent posts (kept for live incoming messages)
const recentNewsContext: string[] = [];
const MAX_CONTEXT_POSTS = 50;

export function addNewsContext(text: string): void {
  recentNewsContext.push(text);
  if (recentNewsContext.length > MAX_CONTEXT_POSTS) {
    recentNewsContext.shift();
  }
}

export function loadInitialContext(messages: string[]): void {
  recentNewsContext.length = 0;
  for (const text of messages) {
    recentNewsContext.push(text);
  }
  while (recentNewsContext.length > MAX_CONTEXT_POSTS) {
    recentNewsContext.shift();
  }
  console.log(`[Context] Loaded ${recentNewsContext.length} messages from DB`);
}

export function getNewsContext(): string {
  return recentNewsContext.join("\n\n---\n\n");
}

/**
 * Ask Claude to extract a time range from the question.
 * Returns { fromUnix, toUnix } or null if no time range detected.
 * Today's date is passed so Claude can resolve relative terms like "yesterday".
 */
async function extractTimeRange(
  question: string
): Promise<{ fromUnix: number; toUnix: number } | null> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const nowCST = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system: `You extract time ranges from news questions. Current time (US Central): ${nowCST}. Current unix timestamp: ${nowUnix}.
If the question asks about a specific time range, respond with ONLY a JSON object: {"from": <unix_timestamp>, "to": <unix_timestamp>}
If no specific time range is mentioned, respond with ONLY: null
Do not explain. Do not add any other text.`,
    messages: [{ role: "user", content: question }],
  });

  const block = result.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;

  const raw = block.text.trim();
  if (raw === "null") return null;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.from === "number" && typeof parsed.to === "number") {
      return { fromUnix: parsed.from, toUnix: parsed.to };
    }
  } catch {}
  return null;
}

/**
 * Extract a search keyword (person, place, event) from the question.
 * Returns the keyword string or null if none detected.
 */
async function extractKeyword(question: string): Promise<string | null> {
  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system: `Extract the main search keyword (person name, place, or event) from the question to search a news database.
Return ONLY the keyword in its original language (Arabic or English). No explanation.
If the question is general (e.g. "what's happening" or "latest news"), return: null`,
    messages: [{ role: "user", content: question }],
  });

  const block = result.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;
  const raw = block.text.trim();
  if (raw === "null" || raw.length === 0 || raw.length > 60) return null;
  return raw;
}

/**
 * Analyze or answer a question using Claude Sonnet.
 * 1. Try time range → query by date
 * 2. Try keyword → search DB
 * 3. Fallback → 50 most recent posts
 */
export async function analyzeQuestion(question: string): Promise<string> {
  // Step 1: try to extract a time range from the question
  const timeRange = await extractTimeRange(question);

  let newsContext: string;
  let contextLabel: string;

  // Cap context at ~3000 tokens (~12000 chars)
  const MAX_CONTEXT_CHARS = 12000;

  function trimToTokenBudget(msgs: { date_cst: string; text: string; date: number }[]): string {
    const lines: string[] = [];
    let total = 0;
    for (const m of [...msgs].reverse()) {
      // Compact timestamp: "Mar 05 02:41" instead of full date string
      const ts = new Date(m.date * 1000).toLocaleString("en-US", {
        timeZone: "America/Chicago", month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const line = `[${ts}] ${m.text}`;
      if (total + line.length > MAX_CONTEXT_CHARS) break;
      lines.unshift(line);
      total += line.length;
    }
    return lines.join("\n");
  }

  if (timeRange) {
    const msgs = getMessagesByTimeRange(
      config.aljazeeraChannelId,
      timeRange.fromUnix,
      timeRange.toUnix
    );
    newsContext = trimToTokenBudget(msgs);
    contextLabel = `Al Jazeera posts from the requested time range`;
    console.log(`[Context] Time-range: ${msgs.length} posts fetched, ${newsContext.length} chars sent`);
  } else {
    const keyword = await extractKeyword(question);
    if (keyword) {
      const msgs = searchMessages(config.aljazeeraChannelId, keyword);
      if (msgs.length > 0) {
        newsContext = trimToTokenBudget(msgs);
        contextLabel = `Al Jazeera posts mentioning "${keyword}"`;
        console.log(`[Context] Keyword "${keyword}": ${msgs.length} posts fetched, ${newsContext.length} chars sent`);
      } else {
        // keyword found but no results — fall back to recent
        const recent = getRecentMessages(config.aljazeeraChannelId, 50);
        newsContext = trimToTokenBudget(recent);
        contextLabel = `Most recent Al Jazeera posts (no results for "${keyword}")`;
        console.log(`[Context] Keyword "${keyword}" had no results, using recent ${recent.length} posts`);
      }
    } else {
      const msgs = getRecentMessages(config.aljazeeraChannelId, 50);
      newsContext = trimToTokenBudget(msgs);
      contextLabel = `Most recent Al Jazeera posts`;
      console.log(`[Context] Recent: ${msgs.length} posts fetched, ${newsContext.length} chars sent`);
    }
  }

  const systemPrompt = [
    "أنت محلل أخبار ذكاء اصطناعي متخصص في أخبار قناة الجزيرة الإنجليزية.",
    "CRITICAL RULE: You MUST always respond exclusively in Arabic (العربية). Never use English or any other language in your responses, no matter what language the user writes in.",
    "Write like a knowledgeable friend texting you about the news — warm, direct, conversational Arabic. Use headers and flowing paragraphs. No bullet points or lists ever. Cover the most important developments with depth and context. Focus on what matters.",
    newsContext
      ? `\n${contextLabel}:\n\n${newsContext}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: question }],
  });

  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  return block.text;
}

/**
 * Generate a digest of the most recent posts.
 */
export async function generateNewsSummary(): Promise<string> {
  const msgs = getRecentMessages(config.aljazeeraChannelId, 50);
  if (msgs.length === 0) {
    return "لا توجد منشورات محفوظة بعد.";
  }

  const newsContext = msgs.map((m) => {
    const ts = new Date(m.date * 1000).toLocaleString("en-US", {
      timeZone: "America/Chicago", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return `[${ts}] ${m.text}`;
  }).join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system:
      "You are a news digest assistant. Summarize the following Al Jazeera news posts into a concise briefing. Write naturally in Arabic like a journalist. Cover only the most important stories. No tables, no long headers. Under 1200 characters.",
    messages: [
      {
        role: "user",
        content: `Please summarize these recent Al Jazeera posts:\n\n${newsContext}`,
      },
    ],
  });

  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  return block.text;
}
