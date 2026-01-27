import "server-only";

export type CacheSignalContext = {
  getOriginalModel(): string | null;
  needsClaudeDisguise?: boolean;
};

export type CacheSignals = {
  hasSystemReminder: boolean;
  hasEmptySystemReminder: boolean;
  hasTools: boolean;
  hasNonEmptyTools: boolean;
  hasSystem: boolean;
  hasNonEmptySystem: boolean;
  hasTitlePrompt: boolean;
  hasAssistantBrace: boolean;
  modelFamily: "haiku" | "sonnet" | "opus" | "other";
  isDisguised: boolean;
};

const TITLE_PROMPT_NEEDLES = ["please write a 5-10 word title"];
const TITLE_PROMPT_NEEDLES_NORMALIZED = TITLE_PROMPT_NEEDLES.map((needle) =>
  normalizePromptText(needle)
);

export function extractCacheSignals(
  request: Record<string, unknown>,
  session: CacheSignalContext
): CacheSignals {
  const model = session.getOriginalModel() || (request.model as string) || "";
  const modelFamily = getModelFamily(model);
  const isDisguised = session.needsClaudeDisguise === true;
  const toolSystemSignals = analyzeToolsAndSystem(request);

  return {
    ...analyzeSystemReminder(request),
    ...toolSystemSignals,
    hasTitlePrompt: containsTitlePrompt(request),
    hasAssistantBrace: containsAssistantBrace(request),
    modelFamily,
    isDisguised,
  };
}

export function resolveCacheSessionKey(request: Record<string, unknown>): string | null {
  const metadata = request.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== "object") return null;
  const userId = metadata.user_id;
  if (typeof userId === "string" && userId.length > 0) {
    return userId;
  }
  return null;
}

function getModelFamily(model: string): "haiku" | "sonnet" | "opus" | "other" {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  return "other";
}

function analyzeToolsAndSystem(request: Record<string, unknown>): {
  hasTools: boolean;
  hasNonEmptyTools: boolean;
  hasSystem: boolean;
  hasNonEmptySystem: boolean;
} {
  const hasTools = Object.hasOwn(request, "tools");
  const tools = request.tools;
  const hasNonEmptyTools = Array.isArray(tools) && tools.length > 0;

  const hasSystem = Object.hasOwn(request, "system");
  const system = request.system;
  const hasNonEmptySystem = Array.isArray(system) && system.length > 0;

  return { hasTools, hasNonEmptyTools, hasSystem, hasNonEmptySystem };
}

function analyzeSystemReminder(request: Record<string, unknown>): {
  hasSystemReminder: boolean;
  hasEmptySystemReminder: boolean;
} {
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { hasSystemReminder: false, hasEmptySystemReminder: false };
  }

  let hasSystemReminder = false;
  let hasEmptySystemReminder = false;

  for (const message of messages) {
    const msg = message as Record<string, unknown>;
    const texts = extractTextBlocks(msg?.content);
    const analysis = analyzeSystemReminderTexts(texts);
    if (analysis.hasSystemReminder) hasSystemReminder = true;
    if (analysis.hasEmptySystemReminder) hasEmptySystemReminder = true;

    if (hasSystemReminder && hasEmptySystemReminder) {
      break;
    }
  }

  return { hasSystemReminder, hasEmptySystemReminder };
}

function containsTitlePrompt(request: Record<string, unknown>): boolean {
  const matchTitlePrompt = (text: string): boolean => {
    const normalized = normalizePromptText(text);
    return TITLE_PROMPT_NEEDLES_NORMALIZED.some((needle) => normalized.includes(needle));
  };

  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  for (const message of messages) {
    const msg = message as Record<string, unknown>;
    const texts = extractTextBlocks(msg?.content);
    if (texts.length > 1) {
      if (matchTitlePrompt(texts.join(" "))) {
        return true;
      }
    }
    for (const text of texts) {
      if (matchTitlePrompt(text)) {
        return true;
      }
    }
  }

  return false;
}

function containsAssistantBrace(request: Record<string, unknown>): boolean {
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "assistant") continue;
    const texts = extractTextBlocks(msg?.content);
    return texts.some((text) => text.trim() === "{");
  }

  return false;
}

function analyzeSystemReminderTexts(texts: string[]): {
  hasSystemReminder: boolean;
  hasEmptySystemReminder: boolean;
} {
  let hasSystemReminder = false;
  let hasEmptySystemReminder = false;

  for (const text of texts) {
    if (!text.includes("<system-reminder>")) continue;

    const regex = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
    let matched = false;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matched = true;
      if (match[1].trim().length > 0) {
        hasSystemReminder = true;
      } else {
        hasEmptySystemReminder = true;
      }
    }

    if (!matched) {
      const start = text.indexOf("<system-reminder>");
      if (start >= 0) {
        const tail = text.slice(start + "<system-reminder>".length);
        if (tail.trim().length > 0) {
          hasSystemReminder = true;
        } else {
          hasEmptySystemReminder = true;
        }
      }
    }

    if (hasSystemReminder && hasEmptySystemReminder) {
      break;
    }
  }

  return { hasSystemReminder, hasEmptySystemReminder };
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        texts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") {
        texts.push(text);
      }
    }
    return texts;
  }

  if (content && typeof content === "object") {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") {
      return [text];
    }
  }

  return [];
}

function normalizePromptText(text: string): string {
  const dashVariantsRegex = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u2011]/g;
  const zeroWidthRegex = /[\u200B-\u200D\uFEFF]/g;
  return text
    .toLowerCase()
    .replace(zeroWidthRegex, "")
    .replace(dashVariantsRegex, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
