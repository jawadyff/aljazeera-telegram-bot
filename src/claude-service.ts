import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

const client = new Anthropic({ apiKey: config.claudeApiKey });

// Rolling window of recent Al Jazeera channel posts used as context
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
 * Analyze or answer a question using Claude Opus, optionally providing
 * recent Al Jazeera news posts as grounding context.
 */
export async function analyzeQuestion(question: string): Promise<string> {
  const newsContext = getNewsContext();

  const systemPrompt = [
    "أنت محلل أخبار ذكاء اصطناعي متخصص في أخبار قناة الجزيرة الإنجليزية.",
    "CRITICAL RULE: You MUST always respond exclusively in Arabic (العربية). Never use English or any other language in your responses, no matter what language the user writes in.",
    "Provide clear, balanced, well-sourced, and informative responses.",
    "When summarizing news, highlight key facts, geopolitical context, and different perspectives.",
    "Be concise but thorough — Telegram messages have a 4096-character limit, so structure your answer clearly.",
    newsContext
      ? `\nRecent Al Jazeera posts for context:\n\n${newsContext}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1500,
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
 * Generate a short digest/summary of recent channel posts on demand.
 */
export async function generateNewsSummary(): Promise<string> {
  const newsContext = getNewsContext();
  if (!newsContext) {
    return "لم يتم التقاط أي منشورات حديثة من قناة الجزيرة بعد. تأكد من إضافة البوت إلى القناة.";
  }

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1500,
    system:
      "You are a news digest assistant. Summarize the following Al Jazeera news posts into a concise, structured briefing with bullet points. Group related stories. Keep it under 1200 characters. IMPORTANT: Always respond in Arabic.",
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
