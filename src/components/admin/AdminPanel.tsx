import { useEffect, useState } from 'preact/hooks';
import type { InviteRole, Role } from '../../../shared/roles';
import { api, errorMessage } from '../../lib/api';
import { getSession } from '../../lib/session';

interface Entry {
  email: string;
  role: InviteRole;
  createdAt: number;
  invitedBy: string | null;
  userId: number | null;
  name: string | null;
  lastLoginAt: number | null;
  disabled: boolean;
}

interface UserRow {
  id: number;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  disabled: boolean;
  lastLoginAt: number | null;
  superuser: boolean;
  role: Role | null;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms: number | null): string {
  if (!ms) return 'never signed in';
  const diff = (ms - Date.now()) / 1000;
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let v = diff;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return `signed in ${rtf.format(Math.round(v), unit)}`;
    v /= size;
  }
  return '';
}

export default function AdminPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [superusers, setSuperusers] = useState<string[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const [list, u] = await Promise.all([
        api<{ superusers: string[]; entries: Entry[] }>('/api/admin/allowlist'),
        api<{ users: UserRow[] }>('/api/admin/users'),
      ]);
      setEntries(list.entries);
      setSuperusers(list.superusers);
      setUsers(u.users);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }

  useEffect(() => {
    void getSession().then((s) => {
      const ok = s?.user.role === 'superuser';
      setAllowed(ok);
      if (ok) void load();
    });
  }, []);

  if (allowed === null) return <p class="muted">Loading…</p>;
  if (!allowed) {
    return (
      <div class="panel">
        <h2>Superusers only</h2>
        <p class="muted">The admin screen is limited to the accounts listed in SUPERUSER_EMAILS.</p>
      </div>
    );
  }

  return (
    <div class="admin">
      {loadError && (
        <p class="tag tag-danger block" role="alert">
          {loadError}
        </p>
      )}
      <InviteForm onDone={load} />

      <section class="panel">
        <h2>
          Invited <span class="num muted">{entries.length}</span>
        </h2>
        {entries.length === 0 ? (
          <p class="muted">No one invited yet.</p>
        ) : (
          <ul class="rows">
            {entries.map((e) => (
              <InviteRow key={e.email} entry={e} onChange={load} />
            ))}
          </ul>
        )}
      </section>

      <section class="panel">
        <h2>Superusers</h2>
        <p class="muted small">
          Set by the <code>SUPERUSER_EMAILS</code> secret. Change it with <code>wrangler secret put</code>.
        </p>
        <ul class="chips">
          {superusers.map((s) => (
            <li key={s} class="tag tag-accent">
              {s}
            </li>
          ))}
        </ul>
      </section>

      <section class="panel">
        <h2>
          Users <span class="num muted">{users.length}</span>
        </h2>
        <p class="muted small">Everyone who has signed in. Disabling ends their access immediately.</p>
        <ul class="rows">
          {users.map((u) => (
            <UserItem key={u.id} user={u} onChange={load} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function InviteForm({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('buyer');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(ev: Event) {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/admin/allowlist', { method: 'POST', body: { email, role } });
      setMsg({ ok: true, text: `Invited ${email.trim().toLowerCase()} as ${role}.` });
      setEmail('');
      await onDone();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="panel invite" onSubmit={submit}>
      <h2>Invite</h2>
      <label class="field">
        <span>Google account email</span>
        <input
          type="email"
          required
          autocomplete="off"
          inputMode="email"
          placeholder="friend@example.com"
          value={email}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
      </label>
      <fieldset class="segmented">
        <legend>Role</legend>
        {(['buyer', 'seller'] as const).map((r) => (
          <label key={r}>
            <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
            <span>{r === 'buyer' ? 'Buyer' : 'Seller (can also buy)'}</span>
          </label>
        ))}
      </fieldset>
      <button class="btn" type="submit" disabled={busy}>
        {busy ? 'Inviting…' : 'Invite'}
      </button>
      {msg && (
        <p class={`tag block ${msg.ok ? 'tag-ok' : 'tag-danger'}`} role="status">
          {msg.text}
        </p>
      )}
    </form>
  );
}

function InviteRow({ entry, onChange }: { entry: Entry; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/admin/allowlist/${encodeURIComponent(entry.email)}`;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li class="row">
      <div class="who">
        <strong class="email">{entry.email}</strong>
        <span class="muted small">
          {entry.name ? `${entry.name} · ` : ''}
          {ago(entry.lastLoginAt)}
          {entry.disabled ? ' · disabled' : ''}
          {entry.invitedBy ? ` · invited by ${entry.invitedBy}` : ''}
        </span>
        {error && <span class="tag tag-danger block">{error}</span>}
      </div>
      <div class="controls">
        <label class="visually-hidden" for={`role-${entry.email}`}>
          Role for {entry.email}
        </label>
        <select
          id={`role-${entry.email}`}
          value={entry.role}
          disabled={busy}
          onChange={(e) => run(() => api(path, { method: 'PATCH', body: { role: e.currentTarget.value } }))}
        >
          <option value="buyer">Buyer</option>
          <option value="seller">Seller</option>
        </select>
        <button
          type="button"
          class="btn btn-ghost danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`Remove ${entry.email}? They lose access immediately.`)) {
              void run(() => api(path, { method: 'DELETE' }));
            }
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function UserItem({ user, onChange }: { user: UserRow; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const verb = user.disabled ? 'Enable' : 'Disable';
    if (!user.disabled && !confirm(`Disable ${user.email}? They are signed out everywhere.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { disabled: !user.disabled } });
      await onChange();
    } catch (err) {
      setError(`${verb} failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const roleTag = user.role ? (
    <span class={`tag ${user.role === 'superuser' ? 'tag-accent' : ''}`}>{user.role}</span>
  ) : (
    <span class="tag tag-warn">no access</span>
  );

  return (
    <li class="row">
      <div class="who">
        <strong>{user.name || user.email}</strong>
        <span class="muted small">
          {user.email} · {ago(user.lastLoginAt)}
        </span>
        <span class="badges">
          {roleTag}
          {user.disabled && <span class="tag tag-danger">disabled</span>}
        </span>
        {error && <span class="tag tag-danger block">{error}</span>}
      </div>
      <div class="controls">
        {!user.superuser && (
          <button type="button" class={`btn btn-ghost ${user.disabled ? '' : 'danger'}`} disabled={busy} onClick={toggle}>
            {user.disabled ? 'Enable' : 'Disable'}
          </button>
        )}
      </div>
    </li>
  );
}
