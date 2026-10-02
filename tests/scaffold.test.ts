import { introspectWorkflowInstance } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env } from './env';

describe('runtime scaffold', () => {
  it('D1 accepts a write and returns it', async () => {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS smoke(id TEXT PRIMARY KEY, at INTEGER NOT NULL)').run();
    await env.DB.prepare('INSERT OR REPLACE INTO smoke(id, at) VALUES(?,?)').bind('a', 1).run();
    const row = await env.DB.prepare('SELECT id, at FROM smoke WHERE id=?').bind('a').first();
    expect(row).toEqual({ id: 'a', at: 1 });
  });

  it('Cloudflare Workflows runs an instance to completion', async () => {
    const instance = await introspectWorkflowInstance(env.TASK_WORKFLOW, 'scaffold-smoke-1');
    await env.TASK_WORKFLOW.create({ id: 'scaffold-smoke-1', params: { taskId: 'scaffold-smoke-1' } });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toEqual({ taskId: 'scaffold-smoke-1' });
    await instance.dispose();
  });
});
