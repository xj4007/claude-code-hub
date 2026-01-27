import { extractCacheSignals, resolveCacheSessionKey } from "@/lib/cache/cache-signals";
import { logger } from "@/lib/logger";
import { parseUserAgent } from "@/lib/ua-parser";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

/**
 * Client (CLI/IDE) guard
 *
 * Validates client User-Agent against allowedClients configuration.
 * Detects Claude CLI requests and routes non-CLI requests to 2api group.
 * Field normalization is handled by ProxyForwarder layer.
 *
 * ⚠️ 仅对 Claude 请求（originalFormat === "claude"）执行 CLI 检测和强制路由
 * 其他请求类型（Codex、OpenAI、Gemini）不受影响
 */
export class ProxyClientGuard {
  /**
   * Build diagnostics for system/messages preview logging (safe, truncated).
   */
  private static buildSystemDiagnostics(requestBody: Record<string, unknown>): {
    systemType: string;
    systemIsArray: boolean;
    systemLen: number | null;
    systemPreview: string | null;
    system0Keys?: string[];
    messages0Preview?: string | null;
  } {
    const system = requestBody.system;
    const systemIsArray = Array.isArray(system);
    const systemType = systemIsArray ? "array" : system === null ? "null" : typeof system;
    const systemLen =
      typeof system === "string" ? system.length : systemIsArray ? system.length : null;

    const sanitize = (value: string): string => {
      const normalized = value.replace(/[\r\n]+/g, " ").trim();
      return normalized.length > 100 ? normalized.slice(0, 100) : normalized;
    };

    let systemPreview: string | null = null;
    let system0Keys: string[] | undefined;

    if (typeof system === "string") {
      systemPreview = sanitize(system);
    } else if (systemIsArray && system.length > 0) {
      const first = system[0] as Record<string, unknown> | string;
      if (typeof first === "string") {
        systemPreview = sanitize(first);
      } else if (first && typeof first === "object") {
        system0Keys = Object.keys(first);
        const text = (first as Record<string, unknown>).text;
        if (typeof text === "string") {
          systemPreview = sanitize(text);
        } else {
          try {
            systemPreview = sanitize(JSON.stringify(first));
          } catch {
            systemPreview = null;
          }
        }
      }
    }

    let messages0Preview: string | null = null;
    const messages = requestBody.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const firstMessage = messages[0] as Record<string, unknown>;
      const content = firstMessage?.content;
      if (Array.isArray(content) && content.length > 0) {
        const firstContent = content[0] as Record<string, unknown> | string;
        const text =
          typeof firstContent === "string"
            ? firstContent
            : (firstContent as Record<string, unknown>)?.text;
        if (typeof text === "string") {
          messages0Preview = sanitize(text);
        }
      }
    }

    return {
      systemType,
      systemIsArray,
      systemLen,
      systemPreview,
      system0Keys,
      messages0Preview,
    };
  }

  /**
   * 检测请求是否为 Claude CLI 请求（组合判断：User-Agent + 请求体特征）
   *
   * Claude CLI 请求特征：
   * 1. User-Agent 包含 claude-cli 或 claude-vscode
   * 2. system[0] 包含 "You are Claude Code, Anthropic's official CLI for Claude"
   *    - 支持标准 CLI 和 Agent SDK 两种变体
   * 3. metadata.user_id 符合 user_{64hex}_account__session_{uuid} 格式
   *
   * @param userAgent - User-Agent 头
   * @param requestBody - 请求体
   * @returns { isCli: boolean, reasons: string[] } - 判定结果和原因
   */
  private static isClaudeCliRequest(
    userAgent: string | null,
    requestBody: Record<string, unknown>
  ): { isCli: boolean; reasons: string[] } {
    const reasons: string[] = [];

    try {
      // 1. User-Agent 检测
      const clientInfo = parseUserAgent(userAgent);
      const isClaudeCliUA =
        clientInfo?.clientType === "claude-cli" || clientInfo?.clientType === "claude-vscode";

      if (!isClaudeCliUA) {
        reasons.push(`UA not Claude CLI (parsed: ${clientInfo?.clientType || "null"})`);
        return { isCli: false, reasons };
      }

      reasons.push(`UA matched: ${clientInfo.clientType}`);

      // 2. 检查 system[0] 是否包含 Claude Code 身份
      // 支持两种变体：
      // - 标准 CLI: "You are Claude Code, Anthropic's official CLI for Claude."
      // - Agent SDK: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
      const system = requestBody.system;
      let hasClaudeIdentity = false;

      const checkClaudeIdentity = (text: string): boolean => {
        return text.includes("You are Claude Code, Anthropic's official CLI for Claude");
      };

      if (typeof system === "string") {
        hasClaudeIdentity = checkClaudeIdentity(system);
      } else if (Array.isArray(system) && system.length > 0) {
        // Compatible with old and new versions:
        // - Old version: Claude Code identity in system[0]
        // - New version: system[0] is billing header, Claude Code identity in system[1]
        for (let i = 0; i < Math.min(system.length, 2); i++) {
          const item = system[i] as Record<string, unknown>;
          const text = item?.text;
          if (typeof text === "string" && checkClaudeIdentity(text)) {
            hasClaudeIdentity = true;
            break;
          }
        }
      }

      if (!hasClaudeIdentity) {
        const systemDiagnostics = ProxyClientGuard.buildSystemDiagnostics(requestBody);
        logger.debug("ProxyClientGuard: Missing Claude Code identity in system", {
          systemType: systemDiagnostics.systemType,
          systemIsArray: systemDiagnostics.systemIsArray,
          systemLen: systemDiagnostics.systemLen,
          systemPreview: systemDiagnostics.systemPreview,
          system0Keys: systemDiagnostics.system0Keys,
          messages0Preview: systemDiagnostics.messages0Preview,
        });
        reasons.push("missing Claude Code identity in system");
        return { isCli: false, reasons };
      }

      reasons.push("has Claude Code identity");

      // 3. 检查 metadata.user_id 格式
      const metadata = requestBody.metadata as Record<string, unknown> | undefined;
      const userId = metadata?.user_id;

      if (typeof userId !== "string") {
        reasons.push("metadata.user_id missing or not string");
        return { isCli: false, reasons };
      }

      // 格式：user_{64位十六进制}_account__session_{uuid}
      const userIdPattern = /^user_[a-f0-9]{64}_account__session_[a-f0-9-]{36}$/;
      if (!userIdPattern.test(userId)) {
        reasons.push(`metadata.user_id format invalid: ${userId.substring(0, 30)}...`);
        return { isCli: false, reasons };
      }

      reasons.push("metadata.user_id format valid");

      // 所有特征匹配，判定为 Claude CLI 请求
      return { isCli: true, reasons };
    } catch (error) {
      logger.debug("ProxyClientGuard: Failed to detect Claude CLI request", { error });
      reasons.push(`detection error: ${String(error)}`);
      return { isCli: false, reasons };
    }
  }

  static async ensure(session: ProxySession): Promise<Response | null> {
    const user = session.authState?.user;
    if (!user) {
      // No user context - skip check (authentication should have failed already)
      return null;
    }

    const recordCacheSignals = () => {
      session.cacheSignals = extractCacheSignals(
        session.request.message as Record<string, unknown>,
        session
      );
      session.cacheSessionKey = resolveCacheSessionKey(
        session.request.message as Record<string, unknown>
      );
    };

    // ⚠️ 仅对 Claude 请求执行 CLI 检测和强制路由
    // 其他请求类型（Codex、OpenAI、Gemini）不受影响
    if (session.originalFormat === "claude") {
      // 执行 Claude CLI 检测（无论是否配置 allowedClients）
      const cliDetection = ProxyClientGuard.isClaudeCliRequest(
        session.userAgent,
        session.request.message
      );

      logger.debug("ProxyClientGuard: Claude CLI detection result", {
        userName: user.name,
        isCli: cliDetection.isCli,
        reasons: cliDetection.reasons,
      });

      // 如果不是 Claude CLI 请求，强制路由到 2api 分组
      if (!cliDetection.isCli) {
        const systemDiagnostics = ProxyClientGuard.buildSystemDiagnostics(
          session.request.message as Record<string, unknown>
        );
        logger.info("ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api", {
          userName: user.name,
          reasons: cliDetection.reasons,
          systemPreview: systemDiagnostics.systemPreview,
        });

        session.forcedProviderGroup = "2api";
        session.needsClaudeDisguise = true;

        recordCacheSignals();
        return null; // 继续管道执行
      }

      // 是 Claude CLI 请求，继续原有的 allowedClients 校验逻辑
      const allowedClients = user.allowedClients ?? [];
      if (allowedClients.length === 0) {
        // No restrictions configured - skip all checks
        logger.debug("ProxyClientGuard: Claude CLI request allowed (no restrictions)", {
          userName: user.name,
        });
        recordCacheSignals();
        return null;
      }

      // Restrictions exist - now User-Agent is required
      const userAgent = session.userAgent;

      // Missing or empty User-Agent when restrictions exist
      if (!userAgent || userAgent.trim() === "") {
        return ProxyResponses.buildError(
          400,
          "Client not allowed. User-Agent header is required when client restrictions are configured.",
          "invalid_request_error"
        );
      }

      // Case-insensitive substring match with hyphen/underscore normalization
      // This handles variations like "gemini-cli" matching "GeminiCLI" or "gemini_cli"
      const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
      const userAgentNorm = normalize(userAgent);
      const isAllowed = allowedClients.some((pattern) => {
        const normalizedPattern = normalize(pattern);
        // Skip empty patterns to prevent includes("") matching everything
        if (normalizedPattern === "") return false;
        return userAgentNorm.includes(normalizedPattern);
      });

      if (!isAllowed) {
        return ProxyResponses.buildError(
          400,
          `Client not allowed. Your client is not in the allowed list.`,
          "invalid_request_error"
        );
      }

      // Client is allowed
      logger.debug("ProxyClientGuard: Claude CLI request allowed (in whitelist)", {
        userName: user.name,
        userAgent,
      });
      recordCacheSignals();
      return null;
    }

    // 非 Claude 请求（Codex、OpenAI、Gemini 等）：跳过所有检测
    logger.debug("ProxyClientGuard: Non-Claude request, skipping CLI detection", {
      userName: user.name,
      originalFormat: session.originalFormat,
    });
    recordCacheSignals();
    return null;
  }
}
