/**
 * 路径通用化工具
 *
 * 将系统特定路径转换为通用格式，避免暴露操作系统信息。
 */

/**
 * 将路径转换为通用格式
 *
 * 示例：
 * - C:\Users\Administrator\.claude\CLAUDE.md → {UNIVERSAL_PATH}/.claude/CLAUDE.md
 * - C:/Users/Administrator/.claude/CLAUDE.md → {UNIVERSAL_PATH}/.claude/CLAUDE.md
 * - /home/user/.claude/CLAUDE.md → {UNIVERSAL_PATH}/.claude/CLAUDE.md
 * - /Users/mac/.claude/CLAUDE.md → {UNIVERSAL_PATH}/.claude/CLAUDE.md
 * - ~/.claude/CLAUDE.md → {UNIVERSAL_PATH}/.claude/CLAUDE.md
 */
export function normalizePathToUniversal(originalPath: string): string {
  // 检测 ~ 开头的路径（用户主目录）
  if (originalPath.startsWith("~/") || originalPath.startsWith("~\\")) {
    return originalPath.replace(/^~[/\\]/, "{UNIVERSAL_PATH}/").replace(/\\/g, "/");
  }

  // 检测 Windows 路径（C:\Users\... 或 C:/Users/...）
  const windowsMatch = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/.exec(originalPath);
  if (windowsMatch) {
    return originalPath.replace(windowsMatch[0], "{UNIVERSAL_PATH}").replace(/\\/g, "/");
  }

  // 检测 Linux 路径（/home/...）
  const linuxMatch = /^\/home\/[^/]+/.exec(originalPath);
  if (linuxMatch) {
    return originalPath.replace(linuxMatch[0], "{UNIVERSAL_PATH}");
  }

  // 检测 macOS 路径（/Users/...）
  const macMatch = /^\/Users\/[^/]+/.exec(originalPath);
  if (macMatch) {
    return originalPath.replace(macMatch[0], "{UNIVERSAL_PATH}");
  }

  // 无法识别的路径，直接返回
  return originalPath;
}

/**
 * 从文本中提取路径并通用化
 *
 * 用于处理包含路径的完整文本块。
 */
export function normalizePathsInText(text: string): string {
  // 匹配 "Contents of xxx/.claude/CLAUDE.md" 格式
  // 注意：需要包含冒号以支持 Windows 路径（C:\Users\...）
  const pathRegex = /Contents of ([^\n\r()]+\.claude\/CLAUDE\.md)/g;

  return text.replace(pathRegex, (match, path) => {
    const normalized = normalizePathToUniversal(path);
    return `Contents of ${normalized}`;
  });
}
