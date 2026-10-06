import { describe, expect, it } from 'vitest';
import { signPrincipal } from '../src/auth/principal-auth';
import { TaskStore } from '../src/taskstore';
import { env } from './env';

const principalId = 'runner-input-reader';
const secret = 'test-principal-secret';

async function makeTask() {
  const store = new TaskStore(env.DB);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const profileId = `profile-${suffix}`;
  const taskId = `ut-${suffix}`;
  const bytes = new TextEncoder().encode('voice payload');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const manifest = {
    contractVersion: 1,
    ref: `ingress-${suffix}`,
    version: 'v1',
    ownerProfileId: profileId,
    mediaType: 'audio/ogg',
    name: 'voice.ogg',
    sizeBytes: bytes.byteLength,
    sha256,
  };
  await store.upsertPrincipal({ principalId, profileId, scopes: ['tasks:read'] });
  await store.admitTask({
    id: taskId,
    profileId,
    goal: 'summarize this recording',
    userValue: { inputItems: [{ text: 'summarize this recording', artifacts: [manifest] }] },
  });
  return { taskId, profileId, manifest, bytes };
}

async function signedHeaders(): Promise<Headers> {
  return new Headers({ 'x-principal': principalId, 'x-principal-sig': await signPrincipal(principalId, secret) });
}

describe('Runner input artifact read API', () => {
  it('returns the ordered, task-bound manifest only to a signed tasks:read principal', async () => {
    const task = await makeTask();
    const mod = await import('../src/index');
    const headers = await signedHeaders();
    const response = await mod.default.fetch(new Request(`https://cp.test/runner/input-manifest?taskId=${task.taskId}`, { headers }), {
      DB: env.DB,
      TASK_WORKFLOW: env.TASK_WORKFLOW,
      PRINCIPAL_SECRET: secret,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      contractVersion: 1,
      userTaskId: task.taskId,
      profileId: task.profileId,
      inputItems: [{ text: 'summarize this recording', artifacts: [task.manifest] }],
    });
    expect(body.manifestRef).toBe(`cp-input-manifest:${task.taskId}`);
    expect(body.manifestVersion).toMatch(/^[a-f0-9]{64}$/);

    const unsigned = await mod.default.fetch(new Request(`https://cp.test/runner/input-manifest?taskId=${task.taskId}`), {
      DB: env.DB,
      TASK_WORKFLOW: env.TASK_WORKFLOW,
      PRINCIPAL_SECRET: secret,
    });
    expect(unsigned.status).toBe(401);
  });

  it('streams only admitted bytes after checking task, pinned manifest, ref and metadata', async () => {
    const task = await makeTask();
    const mod = await import('../src/index');
    const headers = await signedHeaders();
    const manifestResponse = await mod.default.fetch(new Request(`https://cp.test/runner/input-manifest?taskId=${task.taskId}`, { headers }), {
      DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: secret,
    });
    const pinned = await manifestResponse.json() as { manifestRef: string; manifestVersion: string };
    const calls: string[] = [];
    const buffer = {
      fetch: async (request: RequestInfo | URL) => {
        calls.push(String(request));
        return new Response(task.bytes, { headers: {
          'content-type': task.manifest.mediaType,
          'content-length': String(task.manifest.sizeBytes),
          'x-artifact-ref': task.manifest.ref,
          'x-artifact-version': task.manifest.version,
          'x-artifact-owner-profile-id': task.profileId,
          'x-artifact-size-bytes': String(task.manifest.sizeBytes),
          'x-artifact-sha256': task.manifest.sha256,
        } });
      },
    } as unknown as Fetcher;
    const query = new URLSearchParams({
      taskId: task.taskId,
      manifestRef: pinned.manifestRef,
      manifestVersion: pinned.manifestVersion,
      ref: task.manifest.ref,
      version: task.manifest.version,
    });
    const response = await mod.default.fetch(new Request(`https://cp.test/runner/input-artifact?${query}`, { headers }), {
      DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: secret, INGRESS_BUFFER: buffer,
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(task.bytes);
    expect(response.headers.get('x-artifact-sha256')).toBe(task.manifest.sha256);
    expect(calls).toHaveLength(1);

    const staleQuery = new URLSearchParams(query);
    staleQuery.set('manifestVersion', '0'.repeat(64));
    const stale = await mod.default.fetch(new Request(`https://cp.test/runner/input-artifact?${staleQuery}`, { headers }), {
      DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: secret, INGRESS_BUFFER: buffer,
    });
    expect(stale.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('refuses a buffer response whose object metadata differs from the immutable manifest', async () => {
    const task = await makeTask();
    const mod = await import('../src/index');
    const headers = await signedHeaders();
    const manifestResponse = await mod.default.fetch(new Request(`https://cp.test/runner/input-manifest?taskId=${task.taskId}`, { headers }), {
      DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: secret,
    });
    const pinned = await manifestResponse.json() as { manifestRef: string; manifestVersion: string };
    const buffer = {
      fetch: async () => new Response(task.bytes, { headers: {
        'content-type': task.manifest.mediaType,
        'content-length': String(task.manifest.sizeBytes),
        'x-artifact-ref': task.manifest.ref,
        'x-artifact-version': task.manifest.version,
        'x-artifact-owner-profile-id': task.profileId,
        'x-artifact-size-bytes': String(task.manifest.sizeBytes),
        'x-artifact-sha256': '0'.repeat(64),
      } }),
    } as unknown as Fetcher;
    const query = new URLSearchParams({
      taskId: task.taskId,
      manifestRef: pinned.manifestRef,
      manifestVersion: pinned.manifestVersion,
      ref: task.manifest.ref,
      version: task.manifest.version,
    });
    const response = await mod.default.fetch(new Request(`https://cp.test/runner/input-artifact?${query}`, { headers }), {
      DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: secret, INGRESS_BUFFER: buffer,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('input artifact metadata mismatch');
  });
});
