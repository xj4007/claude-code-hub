import { logger } from "@/lib/logger";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

/**
 * Client (CLI/IDE) guard
 *
 * Validates client User-Agent against allowedClients configuration.
 * Field normalization is handled by ProxyForwarder layer.
 */
export class ProxyClientGuard {

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
    return null;
  }
}
