import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { readConfig } from './src/config.ts';
import { createWorkbenchHandler } from './src/server.ts';

const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const distDir = fileURLToPath(new URL('./dist', import.meta.url));
const dependencies = fileURLToPath(new URL('./node_modules', import.meta.url));

function workbenchApi(config: ReturnType<typeof readConfig>): Plugin {
  return {
    name: 'workbench-api',
    apply: 'serve',
    async configureServer(server) {
      const workbench = await createWorkbenchHandler(config);
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next();
        workbench.handle(request, response);
      });
      server.httpServer?.once('close', workbench.close);
    },
  };
}

export default defineConfig(({ command }) => {
  const config = command === 'serve' ? readConfig() : null;
  return {
    root: webRoot,
    publicDir: false,
    plugins: [react(), config && workbenchApi(config)],
    build: { outDir: distDir, emptyOutDir: true },
    server: config ? {
      host: '127.0.0.1',
      port: config.port,
      strictPort: true,
      fs: { allow: [webRoot, dependencies] },
    } : undefined,
  };
});
