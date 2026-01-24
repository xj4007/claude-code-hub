import "server-only";

import { getRedisClient } from "@/lib/redis";
import { extractCacheSignals, type CacheSignals, type CacheSignalContext } from "./cache-signals";

export type UpstreamUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

export type SimulatedUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation_5m_input_tokens: number;
  cache_creation_1h_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
};

const MIN_CACHE_CREATION = 50;

const SESSION_TTL_SECONDS = (() => {
  const raw = Number.parseInt(process.env.SESSION_TTL || "300", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
})();

const LAST_INPUT_KEY_PREFIX = "cache:sim:last_input";

export class CacheSimulator {
  /**
   * 计算模拟缓存 usage（仅依赖上游 usage.input_tokens）
   * 返回 null 表示不模拟（子代理）
   */
  static async calculate(
    request: Record<string, unknown>,
    sessionKey: string | null,
    session: CacheSignalContext,
    upstreamUsage: UpstreamUsage,
    cacheSignals?: CacheSignals
  ): Promise<SimulatedUsage | null> {
    const signals = cacheSignals ?? extractCacheSignals(request, session);

    if (!this.shouldSimulateCache(signals)) {
      return null;
    }

    const currentInputTokens = Math.max(0, upstreamUsage.input_tokens ?? 0);
    const currentOutputTokens = Math.max(0, upstreamUsage.output_tokens ?? 0);
    const lastState = await this.getLastCacheState(sessionKey);
    const lastInputTokens = lastState.lastInputTokens ?? lastState.lastCacheCreationTokens;
    const lastCacheCreationTokens =
      lastState.lastCacheCreationTokens ?? lastState.lastInputTokens;

    if (lastCacheCreationTokens == null) {
      const userTokens = this.countLastUserTextTokens(request);
      const cacheCreation = Math.max(0, currentInputTokens - userTokens);
      await this.setLastCacheState(sessionKey, {
        lastInputTokens: currentInputTokens,
        lastCacheCreationTokens: cacheCreation,
      });
      return this.buildUsage({
        inputTokens: userTokens,
        outputTokens: currentOutputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: cacheCreation,
      });
    }

    const baselineInputTokens = lastInputTokens ?? lastCacheCreationTokens ?? 0;

    if (currentInputTokens < baselineInputTokens) {
      const cacheCreationTokens = Math.floor(currentInputTokens * 0.1);
      const cacheReadTokens = Math.max(0, currentInputTokens - cacheCreationTokens);
      await this.setLastCacheState(sessionKey, {
        lastInputTokens: currentInputTokens,
        lastCacheCreationTokens: cacheReadTokens + cacheCreationTokens,
      });
      return this.buildUsage({
        inputTokens: 0,
        outputTokens: currentOutputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      });
    }

    const delta = Math.max(0, currentInputTokens - lastCacheCreationTokens);
    const { inputTokens, cacheCreationTokens } = this.splitDelta(delta);
    await this.setLastCacheState(sessionKey, {
      lastInputTokens: currentInputTokens,
      lastCacheCreationTokens: lastCacheCreationTokens + cacheCreationTokens,
    });
    return this.buildUsage({
      inputTokens,
      outputTokens: currentOutputTokens,
      cacheReadTokens: lastCacheCreationTokens,
      cacheCreationTokens,
    });
  }

  private static shouldSimulateCache(signals: CacheSignals): boolean {
    return signals.hasSystemReminder || signals.hasEmptySystemReminder;
  }

  private static splitDelta(delta: number): {
    inputTokens: number;
    cacheCreationTokens: number;
  } {
    if (delta <= 0) {
      return { inputTokens: 0, cacheCreationTokens: 0 };
    }
    if (delta < MIN_CACHE_CREATION) {
      return { inputTokens: 0, cacheCreationTokens: delta };
    }

    const cacheCreationTokens = this.randomInt(MIN_CACHE_CREATION, delta);
    const inputTokens = Math.max(0, delta - cacheCreationTokens);
    return { inputTokens, cacheCreationTokens };
  }

  private static buildUsage(args: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }): SimulatedUsage {
    const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = args;

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_creation_5m_input_tokens: cacheCreationTokens,
      cache_creation_1h_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: cacheCreationTokens,
        ephemeral_1h_input_tokens: 0,
      },
    };
  }

  private static countLastUserTextTokens(request: Record<string, unknown>): number {
    const messages = request.messages;
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as Record<string, unknown>;
      if (message?.role !== "user") continue;
      const textLength = this.countTextLength(message?.content);
      return this.estimateTokensFromLength(textLength);
    }

    return 0;
  }

  private static countTextLength(content: unknown): number {
    if (typeof content === "string") {
      return content.length;
    }

    if (Array.isArray(content)) {
      let length = 0;
      for (const block of content) {
        if (typeof block === "string") {
          length += block.length;
          continue;
        }
        if (!block || typeof block !== "object") continue;
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") {
          length += text.length;
        }
      }
      return length;
    }

    if (content && typeof content === "object") {
      const text = (content as Record<string, unknown>).text;
      if (typeof text === "string") {
        return text.length;
      }
    }

    return 0;
  }

  private static estimateTokensFromLength(length: number): number {
    if (!Number.isFinite(length) || length <= 0) return 0;
    return Math.ceil(length / 4);
  }

  private static randomInt(min: number, max: number): number {
    if (max <= min) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private static getLastCacheState(
    sessionKey: string | null
  ): Promise<{ lastInputTokens: number | null; lastCacheCreationTokens: number | null }> {
    if (!sessionKey) {
      return Promise.resolve({ lastInputTokens: null, lastCacheCreationTokens: null });
    }
    const redis = getRedisClient();
    if (!redis || redis.status !== "ready") {
      return Promise.resolve({ lastInputTokens: null, lastCacheCreationTokens: null });
    }
    const key = `${LAST_INPUT_KEY_PREFIX}:${sessionKey}`;

    return redis
      .get(key)
      .then((value) => {
        if (!value) return { lastInputTokens: null, lastCacheCreationTokens: null };
        try {
          const parsed = JSON.parse(value) as
            | {
                input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | number;
          if (typeof parsed === "number") {
            return {
              lastInputTokens: parsed,
              lastCacheCreationTokens: parsed,
            };
          }
          const lastInputTokens =
            typeof parsed.input_tokens === "number" ? parsed.input_tokens : null;
          const lastCacheCreationTokens =
            typeof parsed.cache_creation_input_tokens === "number"
              ? parsed.cache_creation_input_tokens
              : lastInputTokens;
          return { lastInputTokens, lastCacheCreationTokens };
        } catch {
          const asNumber = Number.parseInt(value, 10);
          if (Number.isFinite(asNumber)) {
            return { lastInputTokens: asNumber, lastCacheCreationTokens: asNumber };
          }
        }
        return { lastInputTokens: null, lastCacheCreationTokens: null };
      })
      .catch(() => ({ lastInputTokens: null, lastCacheCreationTokens: null }));
  }

  private static async setLastCacheState(
    sessionKey: string | null,
    state: { lastInputTokens: number; lastCacheCreationTokens: number }
  ): Promise<void> {
    if (!sessionKey) return;
    const redis = getRedisClient();
    if (!redis || redis.status !== "ready") return;
    const key = `${LAST_INPUT_KEY_PREFIX}:${sessionKey}`;
    const payload = JSON.stringify({
      input_tokens: state.lastInputTokens,
      cache_creation_input_tokens: state.lastCacheCreationTokens,
      updatedAt: Date.now(),
    });
    await redis.setex(key, SESSION_TTL_SECONDS, payload);
  }
}
