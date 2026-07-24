export function safeParseJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_{}\[\]()#`>+~|!]/g, '\\$&');
}
