import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TUNING } from './src/core/componentAssembler.ts';
import type { AnchorConvention, TuningConfig } from './src/core/types.ts';
import { deconstructBinarySaveOnServer } from './src/core/valkyrieDeconstructor.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 512 MB bounded stream cap

const VALID_CONVENTIONS = new Set<AnchorConvention>([
  'auto',
  'normalized-tl',
  'normalized-center',
  'layer-offset',
  'stage-world',
]);

function sanitizeFileName(raw: string | undefined): string {
  const base = (raw || 'upload.drm').split(/[/\\]/).pop() || 'upload.drm';
  return base.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload.drm';
}

function parseTuningQuery(req: Request): Partial<TuningConfig> {
  const convRaw = String(req.query.anchorConvention || 'auto') as AnchorConvention;
  const anchorConvention = VALID_CONVENTIONS.has(convRaw) ? convRaw : 'auto';
  const scale = Number(req.query.scaleFactor);
  const ox = Number(req.query.offsetX);
  const oy = Number(req.query.offsetY);
  const reverseZ = req.query.reverseZ === 'true';

  return {
    anchorConvention,
    scaleFactor: Number.isFinite(scale) && scale > 0.05 && scale <= 10 ? scale : DEFAULT_TUNING.scaleFactor,
    offsetX: Number.isFinite(ox) ? ox : 0,
    offsetY: Number.isFinite(oy) ? oy : 0,
    reverseZ,
  };
}

async function startServer() {
  const app = express();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Streaming binary deconstructor endpoint for .drm (Valkyrie / SQLite) and .procreate saves
  app.post('/api/drm/deconstruct', async (req: Request, res: Response) => {
    const fileName = sanitizeFileName(req.header('x-file-name'));
    const tuning = parseTuningQuery(req);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_UPLOAD_BYTES) {
        aborted = true;
        res.status(413).json({
          error: `Upload exceeds ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB streaming limit.`,
        });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (err) => {
      if (!aborted && !res.headersSent) {
        res.status(500).json({ error: err.message || 'Stream read failed.' });
      }
    });

    req.on('end', async () => {
      if (aborted) return;
      try {
        const merged = Buffer.concat(chunks, totalBytes);
        const report = await deconstructBinarySaveOnServer(
          new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
          fileName,
          tuning
        );
        res.json(report);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to deconstruct save file.';
        if (!res.headersSent) {
          res.status(400).json({ error: msg });
        }
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bytruvyus Forge server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
