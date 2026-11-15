import { defineConfig } from 'vite';
import { createThemeScript } from '@ten98/ui';
import { themeStorageKey } from './shared/theme.ts';

export default defineConfig({
  // The saved appearance applies before first paint through @ten98/ui's inline script, first in <head> so it runs before
  // the stylesheet and the application module. It is about 300 bytes, so <meta charset> stays within the first 1024
  // bytes. The server adds the CSP nonce to every <script> in the HTML it serves, so no separate file is needed.
  plugins: [{ name: 'ten98-theme-script', transformIndexHtml: () => [{ tag: 'script', children: createThemeScript(themeStorageKey), injectTo: 'head-prepend' }] }],
  server: {
    host: '127.0.0.1', port: 5178, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3018', changeOrigin: false } },
  },
});
