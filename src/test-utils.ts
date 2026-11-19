import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.unref();
    server.listen(0, () => {
      const addr = server.address()!;
      const port = typeof addr === 'string' ? 0 : addr.port;
      resolve({ url: `http://localhost:${port}`, close: () => server.close() });
    });
  });
}

export async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const orig: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    orig[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(orig)) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  }
}