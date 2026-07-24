import { readFileSync } from 'node:fs';
export function loadEvent() {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) {
        throw new Error('GITHUB_EVENT_PATH not set');
    }
    const data = readFileSync(path, 'utf8');
    let event;
    try {
        event = JSON.parse(data);
    }
    catch (err) {
        throw new Error(`Failed to parse GitHub event payload at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!event.pull_request?.number || !event.pull_request?.head?.sha) {
        throw new Error('No PR number or head SHA in event payload');
    }
    return event;
}
