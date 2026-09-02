import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The control plane interface. Output lands in ../dist/ui and is committed, so
// `npm install mcp-ssh-manager` never builds anything — the same bargain as the
// vendored xterm.js. Nothing in here is a dependency of the published package.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: {
    outDir: resolve(import.meta.dirname, '..', 'dist', 'ui'),
    emptyOutDir: true,
    // One file each: the control plane serves them from an allowlist, and an
    // allowlist of two beats a directory walk it has to sanitise.
    rollupOptions: {
      output: {
        // `main.tsx` imports `App` dynamically, so that preferences are
        // hydrated before any store snapshots them at module-evaluation time.
        // Without this, that one import would split the bundle in two and the
        // control plane serves exactly two files from an allowlist.
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: asset => (asset.names?.[0]?.endsWith('.css') ? 'app.css' : 'assets/[name][extname]'),
        manualChunks: undefined,
      },
    },
  },
});
