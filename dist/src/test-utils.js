import { createServer } from 'node:http';
export function startMockServer(handler) {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.unref();
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'string' ? 0 : addr.port;
            resolve({ url: `http://localhost:${port}`, close: () => server.close() });
        });
    });
}
export async function withEnv(overrides, fn) {
    const orig = {};
    for (const key of Object.keys(overrides)) {
        orig[key] = process.env[key];
        if (overrides[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = overrides[key];
    }
    try {
        await fn();
    }
    finally {
        for (const key of Object.keys(orig)) {
            if (orig[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = orig[key];
        }
    }
}
