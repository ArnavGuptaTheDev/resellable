import { Hono } from 'hono';
import { requireUser } from '../middleware';
import type { AppEnv } from '../types';

const images = new Hono<AppEnv>();
images.use('*', requireUser);

const KEY_RE = /^photos\/[0-9a-f-]{36}(-t)?\.(webp|jpg)$/;

/**
 * Serves a photo from the private bucket to signed-in users.
 * Listed / sold-out items' photos (and listed bundles' covers) are visible to
 * everyone signed in; drafts and hidden items only to their seller and superusers.
 * Keys are immutable, so responses are cacheable forever, but only privately.
 */
images.get('/*', async (c) => {
  const key = c.req.path.replace(/^\/img\//, '');
  if (!KEY_RE.test(key)) return c.notFound();

  const user = c.get('user');
  const visible = await c.env.DB.prepare(
    `SELECT 1 FROM item_photos p JOIN items i ON i.id = p.item_id
      WHERE (p.r2_key = ?1 OR p.thumb_key = ?1)
        AND (i.status IN ('listed', 'sold_out') OR i.seller_id = ?2 OR ?3 = 1
             OR EXISTS (SELECT 1 FROM bundles b WHERE b.cover_photo_id = p.id AND b.status = 'listed')
             -- deal participants keep seeing what they are buying / selling, even once it is hidden or sold out
             OR EXISTS (SELECT 1 FROM deal_lines dl JOIN deals d ON d.id = dl.deal_id
                         WHERE dl.item_id = i.id AND (d.buyer_id = ?2 OR d.seller_id = ?2))
             OR EXISTS (SELECT 1 FROM deal_stock_moves sm JOIN deals d ON d.id = sm.deal_id
                         WHERE sm.item_id = i.id AND (d.buyer_id = ?2 OR d.seller_id = ?2)))
      LIMIT 1`,
  )
    .bind(key, user.id, user.role === 'superuser' ? 1 : 0)
    .first();
  if (!visible) return c.notFound();

  const headers = new Headers({
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });

  const obj = await c.env.IMAGES.get(key, { onlyIf: c.req.raw.headers });
  if (!obj) return c.notFound();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  // onlyIf matched an If-None-Match: object without a body.
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers });
});

export default images;
