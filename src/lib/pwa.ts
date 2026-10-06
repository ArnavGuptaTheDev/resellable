/**
 * Install prompt + Web Push helpers for the browser.
 * The `beforeinstallprompt` event is captured by an inline script in the
 * <head> (Shell.astro) so it is never missed; it is stored on window.__bip.
 */
import { api } from './api';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    __bip?: BeforeInstallPromptEvent | null;
  }
}

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone / iPad (including iPadOS reporting as Mac with touch). */
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export type InstallState = 'installed' | 'prompt' | 'ios' | 'unavailable';

export function installState(): InstallState {
  if (isStandalone()) return 'installed';
  if (window.__bip) return 'prompt';
  if (isIOS()) return 'ios';
  return 'unavailable';
}

/** Shows the browser's install dialog. Returns true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = window.__bip;
  if (!e) return false;
  window.__bip = null; // can only be used once
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}

// ------------------------------------------------------------------ push

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on' | 'unconfigured';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (!(await serverKey())) return 'unconfigured';
  const sub = await (await registration()).pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

let keyCache: Promise<string | null> | null = null;
function serverKey() {
  keyCache ??= api<{ publicKey: string | null }>('/api/push/key')
    .then((r) => r.publicKey)
    .catch(() => null);
  return keyCache;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Must be called from a click/tap (browsers and iOS require a user gesture). */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const key = await serverKey();
  if (!key) return 'unconfigured';
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an older server key can't receive our pushes: replace it.
  const current = sub?.options.applicationServerKey;
  if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))) !== btoa(String.fromCharCode(...keyBytes(key)))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
  return 'on';
}

/** Turns notifications off for this device only. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** Re-sends this device's subscription (keeps the server in sync after sign-in on a shared device). */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (sub) await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
}

export async function sendTestPush(): Promise<{ devices: number; sent: number }> {
  return api('/api/push/test', { method: 'POST' });
}

// ------------------------------------------------------------------ dismissals

const KEY = (what: string) => `dismissed:${what}`;
const TWO_WEEKS = 14 * 24 * 3600 * 1000;

export function dismissedRecently(what: 'install' | 'push'): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(KEY(what)) ?? 0) < TWO_WEEKS;
  } catch {
    return false;
  }
}

export function dismiss(what: 'install' | 'push') {
  try {
    localStorage.setItem(KEY(what), String(Date.now()));
  } catch {
    /* storage blocked: banner just shows again next time */
  }
}
