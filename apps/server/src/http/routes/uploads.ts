import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db/client.js';
import { toAttachmentDTO } from '../../mappers.js';

/**
 * Uploaded files land in the shared "raw materials" area (read-only reference for
 * agents) under an upload/<sessionId> subfolder, and are recorded as attachments.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/upload',
    async (req, reply) => {
      const sessionId = req.params.id;
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!session) return reply.status(404).send({ error: 'session not found' });

      const destDir = path.join(config.paths.rawMaterials, 'uploads', sessionId);
      await fs.promises.mkdir(destDir, { recursive: true });

      const created = [];
      const parts = req.files();
      for await (const part of parts) {
        const safeName = path.basename(part.filename).replace(/[^\w.\-]+/g, '_');
        const dest = path.join(destDir, `${Date.now()}-${safeName}`);
        await pipeline(part.file, fs.createWriteStream(dest));
        const size = (await fs.promises.stat(dest)).size;
        const row = await prisma.attachment.create({
          data: {
            sessionId,
            filename: part.filename,
            path: dest,
            mime: part.mimetype,
            size,
          },
        });
        created.push(toAttachmentDTO(row));
      }

      return { attachments: created };
    },
  );
}
