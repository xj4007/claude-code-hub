import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import type { ProxySession } from "./session";

/**
 * Client (CLI/IDE) guard
 *
 * Lightweight guard that ensures Claude-style requests have the minimum
 * required fields. It no longer forces provider groups or rejects clients.
 */
export class ProxyClientGuard {
  private static ensureClaudeDefaults(session: ProxySession): void {
    // 仅对 Claude 请求格式补全必需字段，避免影响其他协议
    if (session.originalFormat && session.originalFormat !== "claude") {
      return;
    }

    const body = session.request.message as Record<string, unknown>;
    const defaultClientId = "161cf9dec4f981e08a0d7971fa065ca51550a8eb87be857651ae40a20dd9a5ed";
    const claudeIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
    const systemReminder = "<system-reminder></system-reminder>";

    try {
      let addedReminder = false;
      let addedIdentity = false;
      let addedUserId = false;

      // messages: 确保第一条内容包含 system-reminder
      const messages = body.messages as Array<Record<string, unknown>>;
      if (Array.isArray(messages) && messages.length > 0) {
        const firstMessage = messages[0] as Record<string, unknown>;
        let content = firstMessage?.content;

        if (typeof content === "string") {
          content = [{ type: "text", text: content }];
          firstMessage.content = content;
        }

        if (Array.isArray(content)) {
          const hasReminder = content.some(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "text" &&
              String((item as Record<string, unknown>).text || "").includes(systemReminder)
          );

          if (!hasReminder) {
            content.unshift({
              type: "text",
              text: systemReminder,
            });
            addedReminder = true;
          }
        }
      }

      // system: 确保包含 Claude Code 身份标识
      let system = body.system;
      if (typeof system === "string") {
        system = [
          {
            type: "text",
            text: system,
          },
        ];
        body.system = system;
      }

      if (!system) {
        system = [];
        body.system = system;
      }

      if (Array.isArray(system)) {
        const hasIdentity = system.some(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "text" &&
            String((item as Record<string, unknown>).text || "").includes(claudeIdentity)
        );

        if (!hasIdentity) {
          system.unshift({
            type: "text",
            text: claudeIdentity,
          });
          addedIdentity = true;
        }
      }

      // metadata.user_id: 补充缺失的用户标识
      let metadata = body.metadata as Record<string, unknown> | undefined;
      if (!metadata || typeof metadata !== "object") {
        metadata = {};
        body.metadata = metadata;
      }

      if (!metadata.user_id) {
        const sessionUuid = crypto.randomUUID();
        metadata.user_id = `user_${defaultClientId}_account__session_${sessionUuid}`;
        addedUserId = true;
      }

      if (addedReminder || addedIdentity || addedUserId) {
        logger.info("ProxyClientGuard: Normalized Claude request defaults", {
          addedReminder,
          addedIdentity,
          addedUserId,
          userName: session.userName,
        });
      }
    } catch (error) {
      logger.debug("ProxyClientGuard: Failed to normalize Claude request defaults", { error });
    }
  }

  static async ensure(session: ProxySession): Promise<Response | null> {
    ProxyClientGuard.ensureClaudeDefaults(session);
    return null;
  }
}
