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