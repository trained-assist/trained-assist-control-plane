// Own-API dogfood (#23), шаг 5: байты артефакта идут read-only прокси к Runner'у.
// Ключ Runner'а остаётся в binding воркера: в URL клиента его нет.
import { RunnerApiAdapter } from '../src/runner-adapter/runner-api-adapter';
import { describe, expect, it } from 'vitest';

const manifest = {
  artifactId: 'art-1',
  name: 'report.md',
  mime: 'text/markdown',
  size: 11,
  sha256: 'a'.repeat(64),
  storageKey: 'runs/run-1/report.md',
  createdAt: new Date().toISOString(),
  runId: 'run-1',
  userTaskId: 'ut-1',
  profileId: 'profile-1',
};

const bytes = new TextEncoder().encode('# Отчёт\n2+2=4');

const makeAdapter = (calls: string[]) =>
  new RunnerApiAdapter(
    'http://runner.local',
    'runner-secret',
    (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer runner-secret');
      if (url.endsWith('/meta')) {
        return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'text/markdown' } });
    }) as unknown as typeof fetch,
  );

describe('runner-adapter: байты артефакта', () => {
  it('скачивает байты и манифест, ключ только в заголовке', async () => {
    const calls: string[] = [];
    const adapter = makeAdapter(calls);

    const result = await adapter.artifactBytes('art-1');
    expect(new TextDecoder().decode(result.body)).toBe('# Отчёт\n2+2=4');
    expect(result.artifact.sha256).toBe('a'.repeat(64));
    expect(result.artifact.mime).toBe('text/markdown');
    expect(calls).toEqual(['GET http://runner.local/v1/artifacts/art-1', 'GET http://runner.local/v1/artifacts/art-1/meta']);
    // Ключ не утекает в URL — только в заголовок authorization.
    expect(calls.every((c) => !c.includes('runner-secret'))).toBe(true);
  });

  it('недоступный артефакт даёт отказ, а не пустой ответ', async () => {
    const adapter = new RunnerApiAdapter(
      'http://runner.local',
      'runner-secret',
      (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(adapter.artifactBytes('missing')).rejects.toThrow(/404/);
  });
});