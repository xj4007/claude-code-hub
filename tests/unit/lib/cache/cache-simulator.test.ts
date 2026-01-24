import { beforeEach, describe, expect, it, vi } from "vitest";

let redisClientRef: any = null;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redisClientRef,
}));

function makeFakeRedis() {
  const store = new Map<string, string>();
  const client = {
    status: "ready",
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    }),
  };

  return { client, store };
}

function makeRequest(text: string): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-20250212",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text,
          },
        ],
      },
    ],
  };
}

function makeSession(overrides?: Partial<{ needsClaudeDisguise: boolean; model: string }>) {
  const model = overrides?.model ?? "claude-sonnet-4-20250212";
  return {
    getOriginalModel: () => model,
    needsClaudeDisguise: overrides?.needsClaudeDisguise ?? false,
  };
}

describe("CacheSimulator", () => {
  beforeEach(() => {
    redisClientRef = null;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("handles first request using last user text estimate", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");

    const request = makeRequest("abcdefgh");
    const result = await CacheSimulator.calculate(request, "user_1", makeSession(), {
      input_tokens: 10,
      output_tokens: 2,
    });

    expect(result).not.toBeNull();
    expect(result?.input_tokens).toBe(2);
    expect(result?.cache_creation_input_tokens).toBe(8);
    expect(result?.cache_read_input_tokens).toBe(0);
  });

  it("splits delta into cache read and creation with min 50", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    const request = makeRequest("x".repeat(40));
    await CacheSimulator.calculate(request, "user_2", makeSession(), {
      input_tokens: 100,
      output_tokens: 1,
    });

    const result = await CacheSimulator.calculate(request, "user_2", makeSession(), {
      input_tokens: 200,
      output_tokens: 2,
    });

    expect(result?.cache_read_input_tokens).toBe(90);
    expect(result?.cache_creation_input_tokens).toBe(50);
    expect(result?.input_tokens).toBe(60);

    randomSpy.mockRestore();
  });

  it("assigns all delta to cache creation when below minimum", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");

    const request = makeRequest("x".repeat(40));
    await CacheSimulator.calculate(request, "user_3", makeSession(), {
      input_tokens: 100,
      output_tokens: 1,
    });

    const result = await CacheSimulator.calculate(request, "user_3", makeSession(), {
      input_tokens: 120,
      output_tokens: 1,
    });

    expect(result?.cache_read_input_tokens).toBe(90);
    expect(result?.cache_creation_input_tokens).toBe(30);
    expect(result?.input_tokens).toBe(0);
  });

  it("handles compression when current input is below last", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");

    const request = makeRequest("x".repeat(40));
    await CacheSimulator.calculate(request, "user_4", makeSession(), {
      input_tokens: 100,
      output_tokens: 1,
    });

    const result = await CacheSimulator.calculate(request, "user_4", makeSession(), {
      input_tokens: 30,
      output_tokens: 1,
    });

    expect(result?.input_tokens).toBe(0);
    expect(result?.cache_creation_input_tokens).toBe(3);
    expect(result?.cache_read_input_tokens).toBe(27);
  });

  it("skips simulation for title prompt sub-agent", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");

    const request = {
      model: "claude-sonnet-4-20250212",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Please write a 5-10 word title" }],
        },
      ],
    };

    const result = await CacheSimulator.calculate(request, "user_5", makeSession(), {
      input_tokens: 50,
      output_tokens: 1,
    });

    expect(result).toBeNull();
  });

  it("does not skip simulation when system reminder is present", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");

    const request = {
      model: "claude-haiku-20250212",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder> hello" }],
        },
      ],
    };

    const result = await CacheSimulator.calculate(
      request,
      "user_6",
      makeSession({ model: "claude-haiku-20250212", needsClaudeDisguise: true }),
      { input_tokens: 20, output_tokens: 1 }
    );

    expect(result).not.toBeNull();
  });

  it("skips simulation when system reminder tag is empty", async () => {
    const { client } = makeFakeRedis();
    redisClientRef = client;

    const { CacheSimulator } = await import("@/lib/cache/cache-simulator");

    const request = {
      model: "claude-haiku-20250212",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder></system-reminder>" }],
        },
      ],
    };

    const result = await CacheSimulator.calculate(
      request,
      "user_7",
      makeSession({ model: "claude-haiku-20250212", needsClaudeDisguise: true }),
      { input_tokens: 20, output_tokens: 1 }
    );

    expect(result).toBeNull();
  });
});
