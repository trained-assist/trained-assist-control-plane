// Own-API dogfood (#23): exported bytes are read through the run-scoped artifact route.
import { createHash } from 'node:crypto';
import { RunnerApiAdapter } from '../src/runner-adapter/runner-api-adapter';
import { describe, expect, it } from 'vitest';

const bytes = new TextEncoder().encode('# Отчёт\n2+2=4');
const sha256 = createHash('sha256').update(bytes).digest('hex');

const makeAdapter = (calls: string[]) => new RunnerApiAdapter(
  'http://runner.local',
  'runner-secret',
  (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer runner-secret');
    return new Response(bytes, { status: 200, headers: { 'content-type': 'text/markdown', 'content-length': String(bytes.length), 'x-content-sha256': sha256 } });
  }) as unknown as typeof fetch,
);

describe('runner-adapter: байты артефакта', () => {
  it('downloads a manifest-declared output by its run-scoped path, with the key only in a header', async () => {
    const calls: string[] = [];
    const adapter = makeAdapter(calls);

    const result = await adapter.artifactBytesByPath('run_1', 'outputs/agent-note.md');
    expect(new TextDecoder().decode(result.body)).toBe('# Отчёт\n2+2=4');
    expect(result.sha256).toBe(sha256);
    expect(result.mime).toBe('text/markdown');
    expect(calls).toEqual(['GET http://runner.local/v1/runs/run_1/artifacts?path=outputs%2Fagent-note.md']);
    expect(calls.every((call) => !call.includes('runner-secret'))).toBe(true);
  });

  it('rejects an unavailable output instead of returning an empty artifact', async () => {
    const adapter = new RunnerApiAdapter('http://runner.local', 'runner-secret',
      (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch);
    await expect(adapter.artifactBytesByPath('run_1', 'outputs/missing.md')).rejects.toThrow(/404/);
  });

  it('rejects bytes whose digest does not match the Runner response metadata', async () => {
    const adapter = new RunnerApiAdapter('http://runner.local', 'runner-secret',
      (async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length), 'x-content-sha256': '0'.repeat(64) } })) as unknown as typeof fetch);
    await expect(adapter.artifactBytesByPath('run_1', 'outputs/agent-note.md')).rejects.toThrow(/digest/);
  });

  it('stops reading when a streamed body exceeds its declared size', async () => {
    const adapter = new RunnerApiAdapter('http://runner.local', 'runner-secret',
      (async () => new Response(bytes, { status: 200, headers: { 'content-length': '1', 'x-content-sha256': sha256 } })) as unknown as typeof fetch);
    await expect(adapter.artifactBytesByPath('run_1', 'outputs/agent-note.md')).rejects.toThrow(/exceeds its declared size/);
  });
});
