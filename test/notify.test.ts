import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDealNotification, notifyDeal, pushToUser } from '../worker/lib/notify';
import { createTestDb } from './helpers/d1';

// RFC 8291 example keys stand in for a browser subscription and the VAPID pair.
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const UA_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const VAPID_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const VAPID_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';

const deal = {
  id: 7,
  status: 'negotiating' as const,
  buyer_id: 2,
  seller_id: 1,
  buyer_name: 'Alice',
  seller_name: 'Sam',
  fulfilment_method: null,
  fulfilment_notes: null,
  agreed_total: null,
  offer_amount: 560000,
  offer_message: 'Meet in the middle?',
  line_count: 3,
};

describe('composeDealNotification', () => {
  it('goes to the other party, linked and tagged per deal', () => {
    const n = composeDealNotification('offer', deal, 1)!;
    expect(n.to).toBe(2);
    expect(n.payload).toEqual({ title: 'Sam offered ₹5,600', body: '“Meet in the middle?”', url: '/deal?id=7', tag: 'deal-7' });
    expect(composeDealNotification('offer', deal, 2)!.to).toBe(1);
  });

  it('covers every event with readable text', () => {
    expect(composeDealNotification('submitted', deal, 2)!.payload.title).toBe('New offer from Alice');
    expect(composeDealNotification('submitted', deal, 2)!.payload.body).toBe('₹5,600 for 3 items: “Meet in the middle?”');
    expect(composeDealNotification('accepted', { ...deal, agreed_total: 560000 }, 2)!.payload.title).toBe('Deal agreed at ₹5,600');
    expect(composeDealNotification('message', deal, 2, { message: 'Saturday?' })!.payload).toMatchObject({ title: 'Alice', body: 'Saturday?' });
    expect(composeDealNotification('message', deal, 2, {})).toBeNull();
    expect(composeDealNotification('cart_changed', deal, 1)!.payload.title).toBe('Sam changed the cart');
    expect(composeDealNotification('paid', deal, 1)!.payload.title).toBe('Payment confirmed');
    expect(composeDealNotification('fulfilled', { ...deal, fulfilment_method: 'shipping' }, 1)!.payload.title).toBe('Your order has shipped');
    expect(composeDealNotification('completed', deal, 2)!.payload.title).toBe('Deal completed');
    expect(composeDealNotification('cancelled', deal, 2, { reason: 'Found one locally' })!.payload.body).toBe('“Found one locally”');
  });

  it('clips long messages', () => {
    const body = composeDealNotification('message', deal, 2, { message: 'x'.repeat(500) })!.payload.body;
    expect(body.length).toBe(140);
    expect(body.endsWith('…')).toBe(true);
  });

  it('falls back to role names', () => {
    expect(composeDealNotification('offer', { ...deal, seller_name: null }, 1)!.payload.title).toBe('The seller offered ₹5,600');
  });
});

describe('pushToUser / notifyDeal', () => {
  let raw: ReturnType<typeof createTestDb>['raw'];
  let env: Env;
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 201;

  beforeEach(() => {
    const db = createTestDb();
    raw = db.raw;
    env = {
      DB: db.d1,
      SUPERUSER_EMAILS: '',
      VAPID_PUBLIC_KEY: VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: VAPID_PRIVATE,
      VAPID_SUBJECT: 'https://app.example.com',
    } as unknown as Env;
    raw.exec(`
      INSERT INTO users (id, email, name, created_at) VALUES (1, 'sam@example.com', 'Sam', 0), (2, 'alice@example.com', 'Alice', 0);
      INSERT INTO allowlist (email, role, created_at) VALUES ('sam@example.com', 'seller', 0), ('alice@example.com', 'buyer', 0);
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES
        (2, 'https://fcm.googleapis.com/fcm/send/phone', '${UA_PUBLIC}', '${UA_AUTH}', 0),
        (2, 'https://updates.push.services.mozilla.com/wpush/v2/laptop', '${UA_PUBLIC}', '${UA_AUTH}', 0);
    `);
    calls.length = 0;
    status = 201;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const payload = { title: 't', body: 'b', url: '/deals', tag: 'x' };

  it('sends an encrypted push with VAPID to every device of the user', async () => {
    expect(await pushToUser(env, 2, payload, 'high')).toEqual(['sent', 'sent']);
    expect(calls.map((c) => new URL(c.url).host).sort()).toEqual(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('86400');
    expect(h.Urgency).toBe('high');
    expect(h.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${VAPID_PUBLIC}$`));
    const body = calls[0]!.init.body as Uint8Array;
    expect(body[20]).toBe(65); // aes128gcm header: idlen = sender key length
    expect(new TextDecoder().decode(body)).not.toContain('"title"'); // payload is encrypted
  });

  it('deletes subscriptions the push service says are gone', async () => {
    status = 410;
    expect(await pushToUser(env, 2, payload)).toEqual(['gone', 'gone']);
    expect(raw.prepare('SELECT count(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
  });

  it('does not notify users who lost access', async () => {
    raw.exec(`DELETE FROM allowlist WHERE email = 'alice@example.com'`);
    expect(await pushToUser(env, 2, payload)).toEqual([]);
    raw.exec(`INSERT INTO allowlist (email, role, created_at) VALUES ('alice@example.com', 'buyer', 0); UPDATE users SET disabled = 1 WHERE id = 2`);
    expect(await pushToUser(env, 2, payload)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('is a no-op without VAPID keys', async () => {
    expect(await pushToUser({ ...env, VAPID_PRIVATE_KEY: undefined } as Env, 2, payload)).toEqual([]);
  });

  it('never tells a seller about a cart, even an emptied one', async () => {
    raw.exec(`INSERT INTO deals (id, buyer_id, seller_id, status, last_activity_at, created_at, updated_at) VALUES (9, 2, 1, 'cancelled', 0, 0, 0)`);
    raw.exec(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (1, 'https://fcm.googleapis.com/fcm/send/seller', '${UA_PUBLIC}', '${UA_AUTH}', 0)`);
    await notifyDeal(env, 9, 2, 'cancelled');
    expect(calls).toHaveLength(0);
  });

  it('notifies the seller when a submitted deal gets an offer', async () => {
    raw.exec(`
      INSERT INTO deals (id, buyer_id, seller_id, status, last_activity_at, created_at, updated_at) VALUES (9, 2, 1, 'submitted', 0, 0, 0);
      INSERT INTO offers (id, deal_id, made_by, amount, created_at) VALUES (1, 9, 2, 500000, 0);
      UPDATE deals SET live_offer_id = 1 WHERE id = 9;
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (1, 'https://fcm.googleapis.com/fcm/send/seller', '${UA_PUBLIC}', '${UA_AUTH}', 0);
    `);
    await notifyDeal(env, 9, 2, 'submitted');
    expect(calls.map((c) => c.url)).toEqual(['https://fcm.googleapis.com/fcm/send/seller']);
  });
});
