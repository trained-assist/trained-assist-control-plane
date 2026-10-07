import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceTask } from '../src/diagnostics/trace';
import { TaskStore } from '../src/taskstore';
import { env } from './env';

afterEach(() => vi.unstubAllGlobals());

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const setup = async () => {
  const store = new TaskStore(env.DB);
  await store.upsertPrincipal({
    principalId: 'trace-test-principal',
    profileId: 'trace-test-profile',
    scopes: ['tasks:intake', 'tasks:read', 'tasks:signal'],
  });
  return { store };
};

describe('trace endpoint', () => {
  it('assembles admission + task + events + runs + deliveries + artifacts + awaiting', async () => {
    const { store } = await setup();
    const taskId = nextId('trace-task');
    const admit = await store.admitTask({
      id: taskId,
      profileId: 'trace-test-profile',
      goal: 'trace test goal',
      requestId: nextId('trace-request'),
      envelopeHash: 'trace-test-envelope',
      userValue: null,
      executionPolicy: null,
    });
    expect(admit.created).toBe(true);

    const result = await traceTask(store, taskId);

    expect(result.taskId).toBe(taskId);
    expect(result.partial).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.steps).toBeDefined();

    const stepNames = result.steps.map((s) => s.step);
    expect(stepNames).toContain('admission');
    expect(stepNames).toContain('task');
    expect(stepNames).toContain('events');
    expect(stepNames).toContain('run');
    expect(stepNames).toContain('delivery');
    expect(stepNames).toContain('artifacts');
    expect(stepNames).toContain('awaiting');
  });

  it('marks step status honestly when data is missing', async () => {
    const { store } = await setup();
    const result = await traceTask(store, 'nonexistent-task');

    const taskStep = result.steps.find((s) => s.step === 'task');
    expect(taskStep?.status).toBe('unknown');

    const runStep = result.steps.find((s) => s.step === 'run');
    expect(runStep?.status).toBe('none');
  });

  it('never exposes input text or artifact contents', async () => {
    const { store } = await setup();
    const taskId = nextId('trace-redact');
    await store.admitTask({
      id: taskId,
      profileId: 'trace-test-profile',
      goal: 'trace test goal',
      requestId: nextId('trace-redact-request'),
      envelopeHash: 'trace-redact-envelope',
      userValue: null,
      executionPolicy: null,
    });
    const result = await traceTask(store, taskId);
    const json = JSON.stringify(result);
    expect(json).not.toContain('trace test goal');
    expect(json).not.toContain('trace-redact-envelope');
  });

  it('partial flag is set when a query fails', async () => {
    const { store } = await setup();
    const result = await traceTask(store, 'nonexistent-task');
    expect(result.partial).toBe(true);
    expect(result.reason).toBeTruthy();
  });
});
