export function safeParseJson(content) {
    const trimmed = content.trim();
    if (!trimmed)
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
export function escapeMarkdown(text) {
    return text.replace(/[\\*_{}\[\]()#`>+~|!]/g, '\\$&');
}
