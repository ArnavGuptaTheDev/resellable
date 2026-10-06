import { Hono } from 'hono';
import admin from './routes/admin';
import auth from './routes/auth';
import bundles from './routes/bundles';
import catalog from './routes/catalog';
import images from './routes/images';
import items from './routes/items';
import me from './routes/me';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  await next();
  // API responses are per-user; never let a shared cache keep them.
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-store');
});

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'resellable', time: Date.now() }, 200, {
    'Cache-Control': 'no-store',
  }),
);

app.route('/auth', auth);
app.route('/api/me', me);
app.route('/api/admin', admin);
app.route('/api/items', items);
app.route('/api/bundles', bundles);
app.route('/api/catalog', catalog);
app.route('/img', images);

// Anything under the Worker-first prefixes that no route claimed.
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

export default app;
