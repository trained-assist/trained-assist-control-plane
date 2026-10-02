import { describe, expect, it } from 'vitest';
import { env } from './env';

const tableNames = async (): Promise<string[]> => {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all<{ name: string }>();
  return rows.results.map((r) => r.name);
};

const indexSql = async (name: string): Promise<string | null> => {
  const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
    .bind(name)
    .first<{ sql: string | null }>();
  return row?.sql ?? null;
};

describe('migration 0001_task_store_v1', () => {
  it('creates the M1.1 tables', async () => {
    const tables = await tableNames();
    for (const t of ['durable_tasks', 'task_events', 'task_signals', 'awaiting_inputs', 'conversations']) {
      expect(tables).toContain(t);
    }
  });

  it('records the migration in d1_migrations', async () => {
    const row = await env.DB.prepare(`SELECT name FROM d1_migrations WHERE name LIKE '0001%'`).first();
    expect(row).not.toBeNull();
  });

  it('durable_tasks status allows awaiting_input and terminal statuses', async () => {
    const ddl = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name='durable_tasks'`).first<{
      sql: string;
    }>();
    expect(ddl?.sql).toContain("'awaiting_input'");
    expect(ddl?.sql).toContain("'done','failed','cancelled'");
    expect(ddl?.sql).toContain('generation');
    expect(ddl?.sql).toContain('conversation_id');
  });

  it('keeps signal identity UNIQUE (user_task_id, step_key, idempotency_key)', async () => {
    const sql = await env.DB
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_signals'`)
      .first<{ sql: string }>();
    expect(sql?.sql).toMatch(/UNIQUE\s*\(\s*user_task_id\s*,\s*step_key\s*,\s*idempotency_key\s*\)/);
  });

  it('has one-open-awaiting and pending-signal partial indexes', async () => {
    expect(await indexSql('idx_awaiting_one_open')).toContain(`status = 'open'`);
    expect(await indexSql('idx_task_signals_pending')).toContain(`consumed_at IS NULL`);
    expect(await indexSql('idx_task_events_event_id')).toContain(`event_id IS NOT NULL`);
  });
});
