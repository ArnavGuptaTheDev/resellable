import { Hono, type Context } from 'hono';
import { activeSellerArg } from '../lib/catalog';
import {
  DealError,
  acceptOffer,
  addMessage,
  addToCart,
  attention,
  cancelDeal,
  getCarts,
  getDealView,
  listDeals,
  makeOffer,
  removeLine,
  setFulfilment,
  stepStatus,
  submitCart,
  updateLine,
  type AddInput,
} from '../lib/deals';
import { requireUser } from '../middleware';
import type { AppEnv } from '../types';

type Ctx = Context<AppEnv>;

/** Runs a deal operation, mapping DealError to a JSON error response. */
async function run<T>(c: Ctx, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DealError) return c.json({ error: err.code, message: err.message }, err.status);
    throw err;
  }
}

const body = <T>(c: Ctx) => c.req.json<T>().catch(() => ({}) as T);
const id = (c: Ctx, name = 'id') => Number(c.req.param(name));

// ------------------------------------------------------------------ /api/cart

export const cart = new Hono<AppEnv>();
cart.use('*', requireUser);

cart.get('/', async (c) => c.json({ carts: await getCarts(c.env.DB, c.get('user')) }));

cart.post('/lines', (c) =>
  run(c, async () => {
    const dealId = await addToCart(c.env.DB, c.get('user'), await body<AddInput>(c), activeSellerArg(c.env));
    return c.json({ dealId, ...(await attention(c.env.DB, c.get('user'))) }, 201);
  }),
);

// ------------------------------------------------------------------ /api/deals

export const deals = new Hono<AppEnv>();
deals.use('*', requireUser);

deals.get('/', async (c) => {
  const as = c.req.query('as') === 'selling' ? 'seller' : 'buyer';
  return c.json({ deals: await listDeals(c.env.DB, c.get('user'), as) });
});

deals.get('/attention', async (c) => c.json(await attention(c.env.DB, c.get('user'))));

deals.get('/:id{[0-9]+}', (c) =>
  run(c, async () => {
    const since = c.req.query('since');
    const view = await getDealView(c.env.DB, c.get('user'), id(c), since ? Number(since) : null);
    return c.json(view ? { deal: view } : { unchanged: true });
  }),
);

const ok = (c: Ctx) => c.json({ ok: true });

deals.patch('/:id{[0-9]+}/lines/:lineId{[0-9]+}', (c) =>
  run(c, async () => {
    await updateLine(c.env.DB, c.get('user'), id(c), id(c, 'lineId'), await body(c), activeSellerArg(c.env));
    return ok(c);
  }),
);

deals.delete('/:id{[0-9]+}/lines/:lineId{[0-9]+}', (c) =>
  run(c, async () => {
    await removeLine(c.env.DB, c.get('user'), id(c), id(c, 'lineId'));
    return ok(c);
  }),
);

deals.post('/:id{[0-9]+}/submit', (c) =>
  run(c, async () => {
    await submitCart(c.env.DB, c.get('user'), id(c), await body(c), activeSellerArg(c.env));
    return ok(c);
  }),
);

deals.post('/:id{[0-9]+}/offers', (c) =>
  run(c, async () => {
    await makeOffer(c.env.DB, c.get('user'), id(c), await body(c));
    return ok(c);
  }),
);

deals.post('/:id{[0-9]+}/accept', (c) =>
  run(c, async () => {
    const b = await body<{ offerId?: unknown }>(c);
    await acceptOffer(c.env.DB, c.get('user'), id(c), b.offerId);
    return ok(c);
  }),
);

deals.post('/:id{[0-9]+}/messages', (c) =>
  run(c, async () => {
    const b = await body<{ body?: unknown }>(c);
    await addMessage(c.env.DB, c.get('user'), id(c), b.body);
    return ok(c);
  }),
);

deals.post('/:id{[0-9]+}/fulfilment', (c) =>
  run(c, async () => {
    await setFulfilment(c.env.DB, c.get('user'), id(c), await body(c));
    return ok(c);
  }),
);

for (const [path, action] of [
  ['paid', 'mark_paid'],
  ['fulfilled', 'mark_fulfilled'],
  ['complete', 'complete'],
] as const) {
  deals.post(`/:id{[0-9]+}/${path}`, (c) =>
    run(c, async () => {
      await stepStatus(c.env.DB, c.get('user'), id(c), action);
      return ok(c);
    }),
  );
}

deals.post('/:id{[0-9]+}/cancel', (c) =>
  run(c, async () => {
    await cancelDeal(c.env.DB, c.get('user'), id(c), await body(c));
    return ok(c);
  }),
);
