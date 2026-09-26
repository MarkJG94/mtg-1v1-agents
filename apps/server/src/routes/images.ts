import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { imageSizes } from '../images.js';
import type { Services } from '../services.js';
import { HttpError, notFound } from './errors.js';

/** docs/07 `/img/:oracleId?size=small|normal`: a card's image, through the disk cache. */

const params = z.object({ oracleId: z.string().min(1) });
const query = z.object({ size: z.enum(imageSizes).default('normal') });

export const imageRoutes = async (app: FastifyInstance, services: Services): Promise<void> => {
  const { queries, images } = services;

  app.get('/img/:oracleId', async (request, reply) => {
    const { oracleId } = params.parse(request.params);
    const { size } = query.parse(request.query);
    const printing = queries.printing(oracleId);
    if (printing === null) throw notFound(`card ${oracleId}`);
    const result = await images.get(oracleId, printing, size);
    if (result.kind === 'off') {
      throw new HttpError(404, 'images_off', 'card images are turned off (SCRYFALL_IMAGE_CACHE)');
    }
    if (result.kind === 'unavailable') {
      throw new HttpError(
        502,
        'image_unavailable',
        `Scryfall did not give the image (status ${result.status})`,
      );
    }
    return (
      reply
        .header('content-type', 'image/jpeg')
        // A card's image does not change; the cache keeps it for good, and so may the browser.
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-image-cache', result.cached ? 'hit' : 'miss')
        .send(result.bytes)
    );
  });
};
