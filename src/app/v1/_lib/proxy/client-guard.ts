import { logger } from "@/lib/logger";
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
  static async ensure(session: ProxySession): Promise<Response | null> {
    const user = session.authState?.user;
    if (!user) {
      // No user context - skip check (authentication should have failed already)
      return null;
    }

    // Check if client restrictions are configured
    const allowedClients = user.allowedClients ?? [];
    if (allowedClients.length === 0) {
      // No restrictions configured - skip all checks
      return null;
    }

    // 检查请求体是否包含 Claude Code 特征
    const isClaudeCode = ProxyClientGuard.isClaudeCodeRequest(session.request.message);

    logger.debug("ProxyClientGuard: Client validation", {
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

    // Client is allowed
    return null;
  }
}
