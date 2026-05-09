import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const ROMS_DIR = path.resolve(process.cwd(), 'roms');
const ORT_DIST_DIR = path.resolve(
  process.cwd(),
  'node_modules',
  'onnxruntime-web',
  'dist',
);

export default defineConfig({
  // Base URL prefix for the built app. Defaults to "/" for local dev.
  // CI sets VITE_BASE_PATH=/poncho/ when deploying to GitHub Pages.
  base: process.env.VITE_BASE_PATH ?? '/',
  optimizeDeps: {
    // `onnxruntime-web` does internal `import.meta.url`-style
    // resolution for its JSEP `.mjs` + `.wasm` sidecars. Vite's
    // pre-bundling breaks those paths (the bundled cache doesn't
    // contain the sidecars). Excluding lets ORT load as-is from
    // node_modules so its internal imports resolve naturally.
    exclude: ['onnxruntime-web'],
  },
  plugins: [
    {
      // Serve ORT runtime files (`.wasm` + JSEP `.mjs`) directly from
      // `node_modules/onnxruntime-web/dist/` at the `/ort/` URL. The
      // `OnnxUpscaleClient` configures
      // `ort.env.wasm.wasmPaths = '/ort/'` so any explicit redirect
      // hits this middleware. We deliberately don't put these files
      // in `public/` — Vite refuses to module-import files placed
      // there (they're treated as static-only assets), which trips
      // ORT's dynamic `import('…jsep.mjs')` call.
      name: 'poncho-serve-ort-runtime',
      configureServer(server) {
        server.middlewares.use('/ort', (req, res, next) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            if (!/^ort-wasm-simd-threaded\.[\w.]+\.(wasm|mjs)$/.test(rel)) {
              return next();
            }
            const filePath = path.join(ORT_DIST_DIR, rel);
            if (!filePath.startsWith(ORT_DIST_DIR)) {
              res.statusCode = 403;
              res.end();
              return;
            }
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
              return next();
            }
            res.setHeader(
              'Content-Type',
              rel.endsWith('.wasm') ? 'application/wasm' : 'application/javascript',
            );
            fs.createReadStream(filePath).pipe(res);
          } catch {
            next();
          }
        });
      },
    },
    {
      name: 'poncho-serve-roms',
      configureServer(server) {
        server.middlewares.use('/roms', (req, res, next) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            if (rel === '' || rel.endsWith('/')) {
              if (rel === '') {
                const entries = fs.existsSync(ROMS_DIR)
                  ? fs.readdirSync(ROMS_DIR).filter((f) => f.toLowerCase().endsWith('.nes'))
                  : [];
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(entries));
                return;
              }
              next();
              return;
            }
            const filePath = path.join(ROMS_DIR, rel);
            if (!filePath.startsWith(ROMS_DIR)) {
              res.statusCode = 403;
              res.end();
              return;
            }
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
              next();
              return;
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            fs.createReadStream(filePath).pipe(res);
          } catch {
            next();
          }
        });
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
