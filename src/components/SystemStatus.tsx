import { useEffect, useState } from 'preact/hooks';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; latencyMs: number; time: number }
  | { kind: 'error'; message: string };

/** Pings the Worker to prove static assets + API are wired together. */
export default function SystemStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  async function ping() {
    setState({ kind: 'loading' });
    const started = performance.now();
    try {
      const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok: boolean; time: number };
      setState({ kind: 'ok', latencyMs: Math.round(performance.now() - started), time: body.time });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'unreachable' });
    }
  }

  useEffect(() => {
    void ping();
  }, []);

  return (
    <div class="status" aria-live="polite">
      {state.kind === 'loading' && (
        <span class="tag tag-warn">
          <span class="dot pulse" /> Linking to worker…
        </span>
      )}
      {state.kind === 'ok' && (
        <>
          <span class="tag tag-ok">
            <span class="dot" /> Worker online
          </span>
          <span class="muted">
            round trip <span class="num">{state.latencyMs} ms</span> · server clock{' '}
            <span class="num">{new Date(state.time).toLocaleTimeString()}</span>
          </span>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <span class="tag tag-danger">
            <span class="dot" /> Worker unreachable
          </span>
          <span class="muted">{state.message}</span>
        </>
      )}
      <button type="button" class="btn btn-ghost" onClick={() => void ping()}>
        Ping again
      </button>
    </div>
  );
}
