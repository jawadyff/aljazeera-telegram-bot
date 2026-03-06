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
If the question mentions a specific time window (e.g. "last hour", "last 3 hours", "الساعة الأخيرة", "الأربع ساعات الأخيرة"), respond with ONLY this exact format: {"from": <unix>, "to": <unix>}
If NO time window is mentioned, respond with ONLY the word: null
No markdown. No code fences. No explanation.`,
    messages: [{ role: "user", content: question }],
  });

  const block = result.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;

  let raw = block.text.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();

  try {
    const parsed = JSON.parse(raw);
    const from = parsed.from ?? parsed.fromUnix;
    const to = parsed.to ?? parsed.toUnix;
    if (typeof from === "number" && typeof to === "number") {
      return { fromUnix: from, toUnix: to };
    }
  } catch {}
  return null;
}

/**
 * Extract a search keyword and its spelling variants from the question.
 * Returns array of variants (primary + alternates) or null if no keyword.
 * Handles common Arabic spelling variations (hamza forms, taa marbuta, alef maqsura, etc.)
 */
async function extractKeyword(question: string): Promise<string[] | null> {
  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You extract search keywords from news questions to query a database.
If the question mentions ANY specific person, place, organization, or event — extract it and return spelling variants.
For Arabic names, include common variants: أ/إ/آ/ا interchangeable, ة/ه interchangeable, ي/ى interchangeable, short vowels may be missing or added.
Respond with ONLY a JSON array of strings (most canonical first). Example: ["إسماعيل قاني","اسماعيل قاني","إسماعيل قآني","اسماعيل قآني"]
Only return null if the question has NO specific subject at all (e.g. "ما آخر الأخبار؟" or "what's happening").
No explanation. Just the JSON array or null.`,
    messages: [{ role: "user", content: question }],
  });

  const block = result.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;
  // Strip markdown code fences Haiku sometimes adds
  const raw = block.text.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  if (raw === "null") return null;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const variants = parsed.filter((v) => typeof v === "string" && v.length > 0 && v.length <= 80);
      return variants.length > 0 ? variants : null;
    }
  } catch {}
  // fallback: treat whole response as single keyword if short enough
  if (raw.length > 0 && raw.length <= 60) return [raw];
  return null;
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
  console.log(`[Context] Time range extracted: ${JSON.stringify(timeRange)}`);

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
    const variants = await extractKeyword(question);
    console.log(`[Context] Keyword variants extracted: ${JSON.stringify(variants)}`);
    if (variants) {
      // Search all spelling variants, deduplicate by message_id, sort by date
      const seen = new Set<number>();
      const combined: { date_cst: string; text: string; date: number; id: number; message_id: number; channel: string; created_at: number }[] = [];
      for (const v of variants) {
        for (const m of searchMessages(config.aljazeeraChannelId, v)) {
          if (!seen.has(m.message_id)) {
            seen.add(m.message_id);
            combined.push(m);
          }
        }
      }
      combined.sort((a, b) => a.date - b.date);

      if (combined.length > 0) {
        newsContext = trimToTokenBudget(combined);
        contextLabel = `Al Jazeera posts mentioning "${variants[0]}"`;
        console.log(`[Context] Keyword variants ${JSON.stringify(variants)}: ${combined.length} posts fetched, ${newsContext.length} chars sent`);
      } else {
        // keyword found but no results — fall back to recent
        const recent = getRecentMessages(config.aljazeeraChannelId, 50);
        newsContext = trimToTokenBudget(recent);
        contextLabel = `Most recent Al Jazeera posts (no results for "${variants[0]}")`;
        console.log(`[Context] Keyword variants ${JSON.stringify(variants)} had no results, using recent ${recent.length} posts`);
      }
    } else {
      const msgs = getRecentMessages(config.aljazeeraChannelId, 50);
      newsContext = trimToTokenBudget(msgs);
      contextLabel = `Most recent Al Jazeera posts`;
      console.log(`[Context] Recent: ${msgs.length} posts fetched, ${newsContext.length} chars sent`);
    }
  }

  const systemPrompt = [
    "أنت محلل أخبار متخصص في شؤون الشرق الأوسط. أجب دائماً باللغة العربية حصراً.",
    `قواعد الأسلوب — التزم بها حرفياً:
1. لا تبدأ الرد أبداً بعبارة تعجبية أو وصف عاطفي. الجملة الأولى يجب أن تكون معلومة أو موقف، لا وصفاً للجو العام.
2. ممنوع: 'يا صاحبي'، 'الأوضاع وصلت لمستويات'، 'اشتعال شامل'، أي مقدمة درامية من هذا القبيل.
3. ترتيب المحتوى: ابدأ بالتصريحات الدبلوماسية والمواقف السياسية والأرقام والإحصاءات — ثم الغارات والقصف في المنتصف أو الأسفل فقط. الغارات والصواريخ أحداث يومية معتادة في هذا الصراع، لا تستحق الصدارة.
4. لا قوائم ولا نقاط. فقرات متدفقة فقط مع عناوين.
5. اختم بفقرة بعنوان 'التوقعات' فيها تحليلك الخاص لمسار الأحداث.`,
    newsContext
      ? `\n${contextLabel}:\n\n${newsContext}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
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
    model: "claude-haiku-4-5-20251001",
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
