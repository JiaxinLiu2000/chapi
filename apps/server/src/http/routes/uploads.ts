import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, sessionPaths } from '../../config.js';
import { prisma } from '../../db/client.js';
import { toAttachmentDTO } from '../../mappers.js';

/**
 * Uploaded files land in the shared "raw materials" area (read-only reference)
 * AND get a copy in the session sandbox under `uploads/` so the agent can edit
 * them directly. The response carries each file's sandbox-relative path, which
 * the UI appends to the next message so the agent can locate it at once.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/upload',
    async (req, reply) => {
      const sessionId = req.params.id;
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!session) return reply.status(404).send({ error: 'session not found' });

      const rawDir = path.join(config.paths.rawMaterials, 'uploads', sessionId);
      const sandboxUploads = path.join(sessionPaths(sessionId).sandbox, 'uploads');
      await fs.promises.mkdir(rawDir, { recursive: true });
      await fs.promises.mkdir(sandboxUploads, { recursive: true });

      const created = [];
      const parts = req.files();
      for await (const part of parts) {
        const safeName = path.basename(part.filename).replace(/[^\w.\-]+/g, '_');
        const fname = `${Date.now()}-${safeName}`;
        const dest = path.join(rawDir, fname);
        await pipeline(part.file, fs.createWriteStream(dest));
        const size = (await fs.promises.stat(dest)).size;
        // Mirror a copy into the session sandbox so the agent can read/edit it.
        const sandboxRel = path.posix.join('uploads', fname);
        await fs.promises.copyFile(dest, path.join(sandboxUploads, fname)).catch(() => undefined);
        const row = await prisma.attachment.create({
          data: { sessionId, filename: part.filename, path: dest, mime: part.mimetype, size },
        });
        created.push({ ...toAttachmentDTO(row), sandboxPath: sandboxRel });
      }

      return { attachments: created };
    },
  );
}
