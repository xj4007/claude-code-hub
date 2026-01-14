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
   * 检测请求是否为 Claude CLI 请求（组合判断：User-Agent + 请求体特征）
   *
   * Claude CLI 请求特征：
   * 1. User-Agent 包含 claude-cli 或 claude-vscode
   * 2. messages[0].content[0] 包含 <system-reminder>
   * 3. system[0] 包含 "You are Claude Code, Anthropic's official CLI for Claude."
   * 4. metadata.user_id 符合 user_{64hex}_account__session_{uuid} 格式
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
      const system = requestBody.system;
      let hasClaudeIdentity = false;

      if (typeof system === "string") {
        hasClaudeIdentity = system.includes(
          "You are Claude Code, Anthropic's official CLI for Claude."
        );
      } else if (Array.isArray(system) && system.length > 0) {
        const firstSystem = system[0] as Record<string, unknown>;
        const text = firstSystem?.text;
        hasClaudeIdentity =
          typeof text === "string" &&
          text.includes("You are Claude Code, Anthropic's official CLI for Claude.");
      }

      if (!hasClaudeIdentity) {
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
        logger.info("ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api", {
          userName: user.name,
          reasons: cliDetection.reasons,
        });

        session.forcedProviderGroup = "2api";
        session.needsClaudeDisguise = true;

        return null; // 继续管道执行
      }

      // 是 Claude CLI 请求，继续原有的 allowedClients 校验逻辑
      const allowedClients = user.allowedClients ?? [];
      if (allowedClients.length === 0) {
        // No restrictions configured - skip all checks
        logger.debug("ProxyClientGuard: Claude CLI request allowed (no restrictions)", {
          userName: user.name,
        });
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
      return null;
    }

    // 非 Claude 请求（Codex、OpenAI、Gemini 等）：跳过所有检测
    logger.debug("ProxyClientGuard: Non-Claude request, skipping CLI detection", {
      userName: user.name,
      originalFormat: session.originalFormat,
    });
    return null;
  }
}
