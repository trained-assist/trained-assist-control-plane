import { describe, expect, it } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { signPrincipal } from '../src/auth/principal-auth';
import { acceptedAgentInput, agentInputArtifact, type AcceptedAgentInput } from '../src/run-spec/agent-input';
import { buildRunSpec, defaultRunSpecPolicy } from '../src/run-spec/run-spec';
import worker from '../src/index';

async function fixture() {
  const store = new TaskStore(env.DB);
  const taskId = `agent-input-${crypto.randomUUID()}`;
  const principalId = `${taskId}-reader`;
  await store.admitTask({ id: taskId, profileId: taskId, goal: 'Исходная задача\nбез потерь' });
  await store.upsertPrincipal({ principalId, profileId: taskId, scopes: ['tasks:read'] });
  const signature = await signPrincipal(principalId, 'fixture-secret');
  const headers = { 'x-principal': principalId, 'x-principal-sig': signature };
  const bindings = { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: 'fixture-secret' };
  const request = (path: string, authenticated = true) => worker.fetch(new Request(`https://cp.test${path}`, { headers: authenticated ? headers : {} }), bindings);
  const doc: AcceptedAgentInput = { contractVersion: 1, taskId, runId: `run_${crypto.randomUUID()}`, generation: 1,
    input: { inlinePrompt: 'Исходная задача\nбез потерь' }, instructions: 'Сохранённая история\nРежим работы', ingressManifest: null };
  return { store, taskId, doc, request };
}

describe('receipt-backed agent input document', () => {
  it('shows only actual MCP grants and excludes executable and credential configuration', () => {
    const spec = buildRunSpec({ userTaskId: 'task', profileId: 'profile', conversationId: null, ownerGeneration: 1,
      engineName: 'opencode', prompt: 'Task', instructions: 'History', refs: [], inputManifest: null,
      attemptRunId: null, timeoutMs: 120000 }, defaultRunSpecPolicy()).spec;
    spec.mcp = { servers: [{ serverId: 'authorized-history', transport: 'remote',
      url: 'https://private.example.test/mcp', bindingRef: 'private-credential-binding', allowedTools: ['history.read'] }] };
    const doc = acceptedAgentInput(spec, 'run_123', 1);
    expect(doc.mcp).toEqual({ servers: [{ serverId: 'authorized-history', transport: 'remote', allowedTools: ['history.read'] }] });
    expect(JSON.stringify(doc)).not.toContain('private-credential-binding');
    expect(JSON.stringify(doc)).not.toContain('private.example.test');
    spec.mcp.servers[0]!.allowedTools.push('later-tool');
    expect(doc.mcp?.servers[0]!.allowedTools).toEqual(['history.read']);
  });

  it('has no document before Runner admission, including tasks completed by a quick answer', async () => {
    const { taskId, request, store } = await fixture();
    expect(await (await request(`/agent-inputs?taskId=${taskId}`)).json()).toEqual({ taskId, inputs: [] });
    await store.commit(taskId, 1, { status: 'done', stage: 'finished', result: { answer: 'Сервис работает!' } });
    expect(await (await request(`/agent-inputs?taskId=${taskId}`)).json()).toEqual({ taskId, inputs: [] });
  });

  it('returns immutable exact input bytes with digest after admission and through later attempts', async () => {
    const { store, taskId, doc, request } = await fixture();
    await store.saveAcceptedAgentInput(doc);
    await store.saveAcceptedAgentInput({ ...doc, instructions: 'later edited history' });
    const second = { ...doc, runId: `run_${crypto.randomUUID()}`, generation: 2, instructions: 'New instructions' };
    await store.saveAcceptedAgentInput(second);
    const response = await request(`/agent-inputs?taskId=${taskId}`);
    expect(response.status).toBe(200);
    const value = await response.json() as { inputs: { artifact: { ref: string; sha256: string; name: string; sizeBytes: number } }[] };
    expect(value.inputs).toHaveLength(2);
    const artifact = value.inputs[0]!.artifact;
    const bytes = await request(`/artifact?taskId=${taskId}&ref=${artifact.ref}`);
    expect(bytes.headers.get('x-artifact-sha256')).toBe(artifact.sha256);
    expect(bytes.headers.get('content-length')).toBe(String(artifact.sizeBytes));
    expect(bytes.headers.get('content-disposition')).toContain(artifact.name);
    expect(await bytes.json()).toEqual(doc);
    const expected = await agentInputArtifact(doc);
    expect(artifact.sha256).toBe(expected.sha256);
  });

  it('rejects anonymous, cross-profile and cross-task reads without exposing snapshots', async () => {
    const first = await fixture();
    const other = await fixture();
    await first.store.saveAcceptedAgentInput(first.doc);
    expect((await first.request(`/agent-inputs?taskId=${first.taskId}`, false)).status).toBe(401);
    expect((await other.request(`/agent-inputs?taskId=${first.taskId}`)).status).toBe(403);
    expect((await other.request(`/artifact?taskId=${first.taskId}&ref=cp-agent-input:${first.doc.runId}`)).status).toBe(403);
    expect((await other.request(`/artifact?taskId=${other.taskId}&ref=cp-agent-input:${first.doc.runId}`)).status).toBe(404);
  });

  it('snapshots the input projection only, excluding deployment credentials and executable MCP configuration', () => {
    const spec = buildRunSpec({ userTaskId: 'task', profileId: 'profile', conversationId: null, ownerGeneration: 1,
      engineName: 'opencode', prompt: 'Task\nwith Unicode 🧪', instructions: 'History', refs: [], inputManifest: null,
      attemptRunId: null, timeoutMs: 120000 }, defaultRunSpecPolicy()).spec;
    const doc = acceptedAgentInput(spec, 'run_123', 1);
    expect(doc.input).toEqual(spec.input);
    expect(doc.instructions).toBe(spec.instructions);
    expect(doc.scope).toBe('host-input');
    expect(doc.mcp).toEqual({ servers: [] });
    expect(Object.keys(doc)).toEqual(['contractVersion', 'taskId', 'runId', 'generation', 'input', 'instructions', 'ingressManifest', 'scope', 'mcp']);
  });
});
