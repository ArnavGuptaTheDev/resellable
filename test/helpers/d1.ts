/**
 * Minimal D1Database over node:sqlite for tests. Same semantics that matter
 * here: batch() runs as one transaction and rolls back entirely if any
 * statement throws (e.g. CHECK (quantity >= 0)). Every call yields to the
 * event loop first, so concurrent operations interleave like real requests.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const tick = () => new Promise<void>((r) => setImmediate(r));

class Stmt {
  args: SQLInputValue[] = [];
  constructor(
    private db: DatabaseSync,
    public sql: string,
  ) {}
  bind(...args: unknown[]) {
    const s = new Stmt(this.db, this.sql);
    s.args = args.map((a) => (a === undefined ? null : (a as SQLInputValue)));
    return s;
  }
  private returnsRows() {
    return /^\s*(SELECT|WITH|PRAGMA)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
  }
  /** Synchronous execution (used inside batch transactions). */
  exec() {
    const st = this.db.prepare(this.sql);
    if (this.returnsRows()) {
      const results = st.all(...this.args);
      return { results, success: true, meta: { changes: results.length } };
    }
    const r = st.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T>(col?: string): Promise<T | null> {
    await tick();
    const row = this.exec().results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T>() {
    await tick();
    return this.exec() as unknown as { results: T[]; success: true; meta: { changes: number } };
  }
  async run() {
    await tick();
    return this.exec();
  }
}

export function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      await tick();
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql: string) {
      await tick();
      db.exec(sql);
    },
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}
