import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout } from 'node:timers/promises';

export async function listen(server: Server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

export async function stop(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function availablePort() {
  const server = createServer();
  const origin = await listen(server);
  await stop(server);
  return Number(new URL(origin).port);
}

export async function until<T>(read: () => Promise<T | undefined>, timeout = 10_000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await setTimeout(80);
  } while (Date.now() < end);
  throw new Error('Timed out waiting for the expected state');
}
