import { logger } from "@/lib/logger";
import { getInstructionsForModel } from "../codex/constants/codex-instructions";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

/**
 * Client (CLI/IDE) restriction guard
 *
 * Validates that the client making the request is allowed based on request body parameters.
 * This check is ONLY performed when the user has configured client restrictions (allowedClients).
 *
 * Logic:
 * - If allowedClients is empty or undefined: skip all checks, allow request
 * - If allowedClients is non-empty:
 *   - Check if request contains Claude Code features (messages, system, metadata.user_id)
 *   - If not Claude Code: force route to "2api" group with disguise flag
 *   - If Claude Code but User-Agent not in whitelist: force route to "2api" group without disguise
 *   - If Claude Code and User-Agent in whitelist: allow request
 *
 * Matching: case-insensitive substring match for User-Agent
 */
export class ProxyClientGuard {
  /**
   * 检测请求是否包含 Claude Code 终端特征
   *
   * Claude Code 请求特征：
   * 1. messages 数组第一个元素的 content 第一项是 <system-reminder></system-reminder>
   * 2. system 数组第一个元素包含 "You are Claude Code, Anthropic's official CLI for Claude."
   * 3. metadata.user_id 格式符合 user_{64位十六进制}_account__session_{uuid}
   */
  private static isClaudeCodeRequest(requestBody: Record<string, unknown>): boolean {
    try {
      // 检查 messages 特征
      const messages = requestBody.messages as Array<Record<string, unknown>>;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return false;
      }

      const firstMessage = messages[0];
      const content = firstMessage.content as Array<Record<string, unknown>>;
      if (!content || !Array.isArray(content) || content.length === 0) {
        return false;
      }

      const firstContent = content[0];
      if (
        firstContent.type !== "text" ||
        !String(firstContent.text || "").includes("<system-reminder>")
      ) {
        return false;
      }

      // 检查 system 特征
      const system = requestBody.system as Array<Record<string, unknown>>;
      if (!system || !Array.isArray(system) || system.length === 0) {
        return false;
      }

      const firstSystem = system[0];
      if (
        firstSystem.type !== "text" ||
        !String(firstSystem.text || "").includes(
          "You are Claude Code, Anthropic's official CLI for Claude."
        )
      ) {
        return false;
      }

      // 检查 metadata.user_id 格式
      const metadata = requestBody.metadata as Record<string, unknown>;
      if (metadata && metadata.user_id) {
        const userId = String(metadata.user_id);
        const pattern = /^user_[a-f0-9]{64}_account__session_[a-f0-9-]{36}$/;
        return pattern.test(userId);
      }

      // 即使没有 user_id，前两个特征也足够判断
      return true;
    } catch (error) {
      logger.debug("ProxyClientGuard: Failed to detect Claude Code request", { error });
      return false;
    }
  }

  /**
   * 检测请求是否包含 Codex CLI 终端特征
   *
   * Codex CLI 请求特征：
   * 1. instructions 包含官方 Codex CLI prompt（根据模型名称选择）
   * 2. User-Agent 或 originator 包含 "codex_cli_rs"
   * 3. 包含 session_id 和 conversation_id headers（UUID 格式）
   */
  private static isCodexCliRequest(
    requestBody: Record<string, unknown>,
    session: ProxySession
  ): boolean {
    try {
      // 检查 instructions 特征（根据模型名称选择对应的 prompt）
      const instructions = requestBody.instructions as string | undefined;
      const modelName = session.request.model || "gpt-5.2-codex"; // 默认使用 gpt-5.2-codex
      const expectedInstructions = getInstructionsForModel(modelName);

      const hasInstructions = !!instructions;
      const isOfficial = instructions === expectedInstructions;

      logger.debug("ProxyClientGuard: Codex CLI instructions check", {
        hasInstructions,
        isOfficial,
        modelName,
        instructionsLength: instructions?.length || 0,
        expectedLength: expectedInstructions.length,
        instructionsPreview: instructions?.substring(0, 100),
      });

      if (!instructions || !isOfficial) {
        logger.debug("ProxyClientGuard: Failed instructions check", {
          reason: !instructions ? "no_instructions" : "not_official",
          modelName,
        });
        return false;
      }

      // 检查 User-Agent / originator 特征
      const userAgent = session.userAgent || "";
      const originator = session.headers.get("originator") || "";
      const hasCodexUA = userAgent.toLowerCase().includes("codex_cli_rs");
      const hasCodexOriginator = originator.toLowerCase().includes("codex_cli_rs");

      logger.debug("ProxyClientGuard: Codex CLI User-Agent check", {
        userAgent,
        originator,
        hasCodexUA,
        hasCodexOriginator,
      });

      if (!hasCodexUA && !hasCodexOriginator) {
        logger.debug("ProxyClientGuard: Failed User-Agent check");
        return false;
      }

      // 检查 session_id / conversation_id 特征
      const sessionId = session.headers.get("session_id");
      const conversationId = session.headers.get("conversation_id");
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      logger.debug("ProxyClientGuard: Codex CLI session headers check", {
        hasSessionId: !!sessionId,
        hasConversationId: !!conversationId,
        sessionIdValid: sessionId ? uuidPattern.test(sessionId) : false,
        conversationIdValid: conversationId ? uuidPattern.test(conversationId) : false,
      });

      if (!sessionId || !conversationId) {
        logger.debug("ProxyClientGuard: Failed session headers check - missing headers");
        return false;
      }

      if (!uuidPattern.test(sessionId) || !uuidPattern.test(conversationId)) {
        logger.debug("ProxyClientGuard: Failed session headers check - invalid UUID format");
        return false;
      }

      // 三重特征校验通过
      logger.info("ProxyClientGuard: Codex CLI request verified (all checks passed)");
      return true;
    } catch (error) {
      logger.debug("ProxyClientGuard: Failed to detect Codex CLI request", { error });
      return false;
    }
  }
  static async ensure(session: ProxySession): Promise<Response | null> {
    const user = session.authState?.user;
    if (!user) {
      // No user context - skip check (authentication should have failed already)
      logger.debug("ProxyClientGuard: No user context, skipping checks");
      return null;
    }

    // Check if client restrictions are configured
    const allowedClients = user.allowedClients ?? [];

    logger.info("ProxyClientGuard: Checking client restrictions", {
      userName: user.name,
      allowedClients,
      allowedClientsLength: allowedClients.length,
    });

    if (allowedClients.length === 0) {
      // No restrictions configured - skip all checks
      logger.info("ProxyClientGuard: No client restrictions configured, skipping all checks");
      return null;
    }

    // ========== Claude Code 校验逻辑 ==========
    const hasClaudeCodeRestriction = allowedClients.some((c) => c.toLowerCase() === "claude-cli");

    if (hasClaudeCodeRestriction) {
      const isClaudeCode = ProxyClientGuard.isClaudeCodeRequest(session.request.message);

      logger.debug("ProxyClientGuard: Claude Code validation", {
        userName: user.name,
        isClaudeCode,
        allowedClients,
      });

      if (!isClaudeCode) {
        // 非 Claude Code 请求 - 强制路由到 2api 分组
        logger.info("ProxyClientGuard: Non-Claude Code request detected, routing to 2api", {
          userName: user.name,
        });

        session.forcedProviderGroup = "2api";
        // 标记此请求需要伪装（在 forwarder 中使用）
        session.needsClaudeCodeDisguise = true;

        return null; // Continue pipeline with forced routing
      }

      // Claude Code 请求 - 检查是否在白名单中
      const userAgent = session.userAgent || "";
      const userAgentLower = userAgent.toLowerCase();
      const isAllowed = allowedClients.some((pattern) =>
        userAgentLower.includes(pattern.toLowerCase())
      );

      if (!isAllowed) {
        logger.warn("ProxyClientGuard: Claude Code request with invalid User-Agent", {
          userName: user.name,
          userAgent,
          allowedClients,
        });

        // 真实的 Claude Code 请求但 User-Agent 不在白名单 - 也路由到 2api
        session.forcedProviderGroup = "2api";
        // 已经是 Claude Code 格式，不需要伪装
        session.needsClaudeCodeDisguise = false;

        return null;
      }
    }

    // ========== Codex CLI 校验逻辑 ==========
    const hasCodexRestriction = allowedClients.some((c) => c.toLowerCase() === "codex-cli");

    logger.info("ProxyClientGuard: Codex CLI restriction check", {
      hasCodexRestriction,
      allowedClients,
    });

    if (hasCodexRestriction) {
      const isCodexCli = ProxyClientGuard.isCodexCliRequest(session.request.message, session);

      logger.debug("ProxyClientGuard: Codex CLI validation", {
        userName: user.name,
        isCodexCli,
        allowedClients,
      });

      if (!isCodexCli) {
        // 非 Codex CLI 请求 - 强制路由到 2apiCodex 分组
        logger.info("ProxyClientGuard: Non-Codex CLI request detected, routing to 2apiCodex", {
          userName: user.name,
          hasInstructions: !!session.request.message.instructions,
          instructionsPreview:
            typeof session.request.message.instructions === "string"
              ? session.request.message.instructions.substring(0, 100)
              : "N/A",
        });

        session.forcedProviderGroup = "2apiCodex";
        // 标记此请求需要 Codex CLI 伪装
        session.needsCodexCliDisguise = true;

        logger.info("ProxyClientGuard: Set needsCodexCliDisguise flag", {
          userName: user.name,
          needsCodexCliDisguise: session.needsCodexCliDisguise,
        });

        return null; // Continue pipeline with forced routing
      }

      // Codex CLI 请求 - 检查 User-Agent 是否在白名单中
      const userAgent = session.userAgent || "";
      const userAgentLower = userAgent.toLowerCase();
      const isAllowed = allowedClients.some((pattern) =>
        userAgentLower.includes(pattern.toLowerCase())
      );

      if (!isAllowed) {
        logger.warn("ProxyClientGuard: Codex CLI request with invalid User-Agent", {
          userName: user.name,
          userAgent,
          allowedClients,
        });

        // 真实的 Codex CLI 请求但 User-Agent 不在白名单 - 也路由到 2apiCodex
        session.forcedProviderGroup = "2apiCodex";
        // 已经是 Codex CLI 格式，不需要伪装
        session.needsCodexCliDisguise = false;

        return null;
      }
    }

    // Client is allowed
    return null;
  }
}
