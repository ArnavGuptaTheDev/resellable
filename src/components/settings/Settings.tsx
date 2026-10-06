import { useEffect, useState } from 'preact/hooks';
import { canSell } from '../../../shared/roles';
import { errorMessage } from '../../lib/api';
import { disablePush, enablePush, installState, promptInstall, pushState, sendTestPush, type InstallState, type PushState } from '../../lib/pwa';
import { getSession, type Session } from '../../lib/session';

const PUSH_TEXT: Record<PushState, string> = {
  on: 'On for this device.',
  off: 'Off for this device.',
  denied: 'Blocked in your browser settings. Allow notifications for this site there, then come back.',
  'needs-install': 'On iPhone and iPad, notifications work once Resellable is on your Home Screen (see Install below).',
  unsupported: "This browser doesn't support web notifications.",
  unconfigured: 'Notifications are not set up on the server yet.',
};

export default function Settings() {
  const [session, setSession] = useState<Session | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [install, setInstall] = useState<InstallState>(installState());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void getSession().then(setSession);
    void pushState().then(setPush);
    const refresh = () => setInstall(installState());
    addEventListener('bip-ready', refresh);
    addEventListener('appinstalled', refresh);
    return () => {
      removeEventListener('bip-ready', refresh);
      removeEventListener('appinstalled', refresh);
    };
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
      setPush(await pushState());
    }
  }

  return (
    <div class="settings">
      <section class="panel">
        <h2 class="section-title">Notifications</h2>
        <p class="muted">You get a notification when the other side of a deal makes or accepts an offer, messages you, changes the cart, or moves the deal on (paid, shipped, completed, cancelled).</p>
        <p class={`tag block ${push === 'on' ? 'tag-ok' : push === 'denied' ? 'tag-danger' : ''}`}>{push ? PUSH_TEXT[push] : 'Checking…'}</p>
        <div class="row-actions">
          {push === 'off' && (
            <button type="button" class="btn" disabled={busy} onClick={() => run(async () => void (await enablePush()))}>
              Turn on notifications
            </button>
          )}
          {push === 'on' && (
            <>
              <button
                type="button"
                class="btn"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await sendTestPush();
                    setMsg({ ok: r.sent > 0, text: r.sent ? `Test sent to ${r.sent} device${r.sent > 1 ? 's' : ''}.` : 'No device received it. Try turning notifications off and on.' });
                  })
                }
              >
                Send a test
              </button>
              <button type="button" class="btn btn-ghost" disabled={busy} onClick={() => run(disablePush)}>
                Turn off on this device
              </button>
            </>
          )}
        </div>
        {msg && <p class={`tag block ${msg.ok ? 'tag-ok' : 'tag-danger'}`}>{msg.text}</p>}
        <p class="muted small">Notifications are per device: turn them on on each phone or computer you use. Signing out turns them off for that device.</p>
      </section>

      <section class="panel">
        <h2 class="section-title">Install the app</h2>
        {install === 'installed' && <p class="tag tag-ok block">You're using the installed app.</p>}
        {install === 'prompt' && (
          <>
            <p class="muted">Adds Resellable to your home screen or dock. It opens in its own window and works offline.</p>
            <button type="button" class="btn" onClick={() => void promptInstall().then(() => setInstall(installState()))}>
              Install Resellable
            </button>
          </>
        )}
        {install === 'ios' && (
          <ol class="steps-list">
            <li>
              Open this site in <strong>Safari</strong>.
            </li>
            <li>
              Tap <strong>Share</strong> (the square with an arrow).
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
            </li>
            <li>Open Resellable from your Home Screen and turn notifications on here.</li>
          </ol>
        )}
        {install === 'unavailable' && (
          <p class="muted">
            Your browser can install Resellable from its menu (look for <strong>Install app</strong> or <strong>Add to Home screen</strong>). Chrome and Edge also show an install icon in the address bar.
          </p>
        )}
      </section>

      <section class="panel">
        <h2 class="section-title">Account</h2>
        {session && (
          <dl class="facts">
            <div>
              <dt>Signed in as</dt>
              <dd>{session.user.email}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{session.user.role}</dd>
            </div>
          </dl>
        )}
        {session && canSell(session.user.role) && (
          <p>
            <a href="/deals?as=selling#payment">Edit how buyers pay you →</a>
          </p>
        )}
      </section>
    </div>
  );
}
