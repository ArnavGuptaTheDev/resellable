/**
 * App notifications (Web Push) for deal activity. Fire-and-forget: callers run
 * these in ctx.waitUntil so a slow push service never delays the response.
 */
import type { DealStatus } from '../../shared/deals';
import { formatMoney } from '../../shared/money';
import { effectiveRole } from './access';
import { sendPush, type SendResult, type Subscription, type VapidConfig } from './webpush';

export type DealEvent =
  | 'submitted'
  | 'offer'
  | 'accepted'
  | 'message'
  | 'cart_changed'
  | 'fulfilment'
  | 'paid'
  | 'fulfilled'
  | 'completed'
  | 'cancelled';

export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  /** Same tag replaces the previous notification for that deal. */
  tag: string;
}

export function vapidConfig(env: Env): VapidConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || env.VAPID_PUBLIC_KEY.startsWith('REPLACE_')) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:admin@example.com' };
}

interface DealInfo {
  id: number;
  status: DealStatus;
  buyer_id: number;
  seller_id: number;
  buyer_name: string | null;
  seller_name: string | null;
  fulfilment_method: 'shipping' | 'pickup' | null;
  fulfilment_notes: string | null;
  agreed_total: number | null;
  offer_amount: number | null;
  offer_message: string | null;
  line_count: number;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Who to notify and what to say. Pure; covered by test/notify.test.ts. */
export function composeDealNotification(
  event: DealEvent,
  d: DealInfo,
  actorId: number,
  extra: { message?: string; reason?: string | null } = {},
): { to: number; payload: NotificationPayload } | null {
  const actorIsBuyer = actorId === d.buyer_id;
  const to = actorIsBuyer ? d.seller_id : d.buyer_id;
  const who = (actorIsBuyer ? d.buyer_name : d.seller_name) ?? (actorIsBuyer ? 'The buyer' : 'The seller');
  const url = `/deal?id=${d.id}`;
  const tag = `deal-${d.id}`;
  const items = `${d.line_count} item${d.line_count === 1 ? '' : 's'}`;
  const offer = d.offer_amount != null ? formatMoney(d.offer_amount) : '';
  const p = (title: string, body: string) => ({ to, payload: { title, body: clip(body), url, tag } });

  switch (event) {
    case 'submitted':
      return p(`New offer from ${who}`, `${offer} for ${items}${d.offer_message ? `: “${d.offer_message}”` : ''}`);
    case 'offer':
      return p(`${who} offered ${offer}`, d.offer_message ? `“${d.offer_message}”` : `Deal #${d.id}: accept or counter.`);
    case 'accepted':
      return p(`Deal agreed at ${d.agreed_total != null ? formatMoney(d.agreed_total) : offer}`, `${who} accepted. Arrange payment and hand-over.`);
    case 'message':
      return extra.message ? p(who, extra.message) : null;
    case 'cart_changed':
      return p(`${who} changed the cart`, `Deal #${d.id}: the last offer was withdrawn. Make a new one.`);
    case 'fulfilment':
      return p(
        `${who} set ${d.fulfilment_method === 'shipping' ? 'shipping' : 'pickup'}`,
        d.fulfilment_notes ?? `Deal #${d.id}: hand-over details updated.`,
      );
    case 'paid':
      return p('Payment confirmed', `${who} marked deal #${d.id} paid.`);
    case 'fulfilled':
      return p(d.fulfilment_method === 'shipping' ? 'Your order has shipped' : 'Marked as picked up', 'Confirm in the app once you have it.');
    case 'completed':
      return p('Deal completed', `${who} confirmed they received deal #${d.id}.`);
    case 'cancelled':
      return p(`${who} cancelled deal #${d.id}`, extra.reason ? `“${extra.reason}”` : 'The deal was cancelled.');
  }
}

/** Sends to every subscription of a user who still has access; prunes dead ones. */
export async function pushToUser(env: Env, userId: number, payload: NotificationPayload, urgency: 'normal' | 'high' = 'normal'): Promise<SendResult[]> {
  const vapid = vapidConfig(env);
  if (!vapid) return [];
  const user = await env.DB.prepare(
    'SELECT u.email, u.disabled, a.role AS allow_role FROM users u LEFT JOIN allowlist a ON a.email = u.email WHERE u.id = ?',
  )
    .bind(userId)
    .first<{ email: string; disabled: number; allow_role: 'seller' | 'buyer' | null }>();
  if (!user || !effectiveRole(env, user.email, user.allow_role, user.disabled === 1)) return [];

  const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').bind(userId).all<Subscription & { id: number }>();
  const now = Date.now();
  return Promise.all(
    results.map(async (s) => {
      let r: SendResult;
      try {
        r = await sendPush(s, payload, vapid, { urgency });
      } catch (err) {
        console.warn('push error', err);
        r = 'failed';
      }
      if (r === 'gone') await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(s.id).run();
      else if (r === 'sent') await env.DB.prepare('UPDATE push_subscriptions SET last_sent_at = ?, failures = 0 WHERE id = ?').bind(now, s.id).run();
      // Drop subscriptions that keep failing for other reasons.
      else
        await env.DB.batch([
          env.DB.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').bind(s.id),
          env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND failures >= 5').bind(s.id),
        ]);
      return r;
    }),
  );
}

/** Loads the deal, composes the message for the other party and sends it. */
export async function notifyDeal(env: Env, dealId: number, actorId: number, event: DealEvent, extra: { message?: string; reason?: string | null } = {}) {
  if (!vapidConfig(env)) return;
  const d = await env.DB.prepare(
    `SELECT d.id, d.status, d.buyer_id, d.seller_id, d.fulfilment_method, d.fulfilment_notes, d.agreed_total,
            b.name AS buyer_name, s.name AS seller_name, o.amount AS offer_amount, o.message AS offer_message,
            (SELECT count(*) FROM deal_lines l WHERE l.deal_id = d.id AND l.removed_at IS NULL) AS line_count,
            (SELECT count(*) FROM offers x WHERE x.deal_id = d.id) AS offer_count
       FROM deals d JOIN users b ON b.id = d.buyer_id JOIN users s ON s.id = d.seller_id
       LEFT JOIN offers o ON o.id = d.live_offer_id
      WHERE d.id = ?`,
  )
    .bind(dealId)
    .first<DealInfo & { offer_count: number }>();
  // Carts are private to the buyer (an emptied cart is 'cancelled' with no offers): nothing to tell the seller.
  if (!d || d.status === 'cart' || d.offer_count === 0) return;
  const n = composeDealNotification(event, d, actorId, extra);
  if (n) await pushToUser(env, n.to, n.payload, event === 'submitted' || event === 'offer' || event === 'accepted' ? 'high' : 'normal');
}
