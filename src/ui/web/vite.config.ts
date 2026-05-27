import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the local UI. In production, `pnpm build` outputs static
// assets into `src/ui/web/dist/` which the Hono server then serves.
// In dev, `pnpm dev:ui` runs the Vite dev server with `/api/*` proxied to
// a Hono instance on a fixed port.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5574',
    },
  },
  build: {
    // Output directly into the editor's dist/ so the published package ships
    // both the JS bundle (tsup-built) and the static UI in one place.
    outDir: '../../../dist/web',
    emptyOutDir: true,
  },
});
