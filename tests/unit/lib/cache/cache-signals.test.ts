import { describe, expect, it, vi } from "vitest";

import { extractCacheSignals, resolveCacheSessionKey } from "@/lib/cache/cache-signals";

vi.mock("server-only", () => ({}));

describe("cache-signals", () => {
  it("detects title prompt and system reminder flags", () => {
    const request = {
      model: "claude-sonnet-4-20250212",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder> hello" },
            { type: "text", text: "Please write a 5-10 word title" },
          ],
        },
      ],
    };

    const signals = extractCacheSignals(request, {
      getOriginalModel: () => "claude-sonnet-4-20250212",
      needsClaudeDisguise: false,
    });

    expect(signals.modelFamily).toBe("sonnet");
    expect(signals.hasSystemReminder).toBe(true);
    expect(signals.hasEmptySystemReminder).toBe(false);
    expect(signals.hasTitlePrompt).toBe(true);
    expect(signals.hasAssistantBrace).toBe(false);
    expect(signals.isDisguised).toBe(false);
  });

  it("detects title prompt with dash variants and spacing", () => {
    const request = {
      model: "claude-sonnet-4-20250212",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please write a 5 \u2013 10 word title for the following conversation.",
            },
          ],
        },
      ],
    };

    const signals = extractCacheSignals(request, {
      getOriginalModel: () => "claude-sonnet-4-20250212",
      needsClaudeDisguise: false,
    });

    expect(signals.hasTitlePrompt).toBe(true);
  });

  it("detects empty system reminder tag", () => {
    const request = {
      model: "claude-sonnet-4-20250212",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder></system-reminder>" }],
        },
      ],
    };

    const signals = extractCacheSignals(request, {
      getOriginalModel: () => "claude-sonnet-4-20250212",
      needsClaudeDisguise: false,
    });

    expect(signals.hasSystemReminder).toBe(false);
    expect(signals.hasEmptySystemReminder).toBe(true);
  });

  it("detects assistant brace in messages", () => {
    const request = {
      model: "claude-haiku-4-5-20251001",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "{" }] },
      ],
    };

    const signals = extractCacheSignals(request, {
      getOriginalModel: () => "claude-haiku-4-5-20251001",
      needsClaudeDisguise: true,
    });

    expect(signals.modelFamily).toBe("haiku");
    expect(signals.hasTitlePrompt).toBe(false);
    expect(signals.hasAssistantBrace).toBe(true);
  });

  it("uses only the last assistant message for brace detection", () => {
    const request = {
      model: "claude-haiku-4-5-20251001",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "{" }] },
        { role: "assistant", content: [{ type: "text", text: "not brace" }] },
      ],
    };

    const signals = extractCacheSignals(request, {
      getOriginalModel: () => "claude-haiku-4-5-20251001",
      needsClaudeDisguise: true,
    });

    expect(signals.hasAssistantBrace).toBe(false);
  });

  it("marks disguise when needsClaudeDisguise is true", () => {
    const request = {
      model: "claude-haiku-20250212",
      messages: [{ role: "user", content: "hello" }],
    };

    const signals = extractCacheSignals(request, {
      getOriginalModel: () => "claude-haiku-20250212",
      needsClaudeDisguise: true,
    });

    expect(signals.modelFamily).toBe("haiku");
    expect(signals.isDisguised).toBe(true);
    expect(signals.hasSystemReminder).toBe(false);
    expect(signals.hasEmptySystemReminder).toBe(false);
    expect(signals.hasTitlePrompt).toBe(false);
  });

  it("resolves cache session key from metadata.user_id only", () => {
    expect(resolveCacheSessionKey({})).toBeNull();
    expect(resolveCacheSessionKey({ metadata: { user_id: 123 } })).toBeNull();
    expect(resolveCacheSessionKey({ metadata: { user_id: "" } })).toBeNull();
    expect(resolveCacheSessionKey({ metadata: { user_id: "user_abc" } })).toBe("user_abc");
  });
});
