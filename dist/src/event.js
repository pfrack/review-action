import { readFileSync } from 'node:fs';
export function loadEvent() {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) {
        throw new Error('GITHUB_EVENT_PATH not set');
    }
    const data = readFileSync(path, 'utf8');
    const event = JSON.parse(data);
    if (!event.pull_request?.number) {
        throw new Error('No PR number in event payload');
    }
    return event;
}
