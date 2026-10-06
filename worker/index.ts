import { Hono } from 'hono';

export type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'resellable', time: Date.now() }, 200, {
    'Cache-Control': 'no-store',
  }),
);

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
