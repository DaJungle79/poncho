import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const ROMS_DIR = path.resolve(process.cwd(), 'roms');

export default defineConfig({
  // Base URL prefix for the built app. Defaults to "/" for local dev.
  // CI sets VITE_BASE_PATH=/poncho/ when deploying to GitHub Pages.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [
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
