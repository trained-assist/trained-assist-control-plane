import { IntakeService, deriveUserTaskId } from '../src/intake';
import { EnvelopeConflictError, PrincipalForbiddenError, PrincipalUnauthorizedError } from '../src/intake/errors';
import { TaskStore } from '../src/taskstore';
import { describe, expect, it, vi } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const setup = async () => {
  const store = new TaskStore(env.DB);
  const intake = new IntakeService(store);
  await store.upsertPrincipal({
    principalId: 'sandbox-local',
    profileId: 'profile-1',
    scopes: ['tasks:intake', 'tasks:read', 'tasks:signal'],
  });
  await store.upsertPrincipal({
    principalId: 'sandbox-reader',
    profileId: 'profile-1',
    scopes: ['tasks:read'],
  });
  await store.upsertPrincipal({
    principalId: 'sandbox-other-profile',
    profileId: 'profile-2',
    scopes: ['tasks:intake'],
  });
  return { store, intake };
};

const envelope = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  requestId: nextId('req'),
  profileId: 'profile-1',
  inputItems: [{ text: 'принять задачу' }],
  ...overrides,
});

describe('Intake: квитанция и идемпотентность (C01)', () => {
  it('приём создаёт задачу и квитанцию; повтор с тем же payload возвращает ТУ ЖЕ квитанцию', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-dup');

    const first = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }));
    expect(first.duplicate).toBe(false);
    expect(first.receipt.durable).toBe(true);
    expect(first.receipt.requestId).toBe(requestId);
    expect(first.receipt.userTaskId).toBe(first.userTaskId);
    expect(first.receipt.acceptedAt).toBeGreaterThan(0);

    const second = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }));
    expect(second.duplicate).toBe(true);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.receipt.userTaskId).toBe(first.receipt.userTaskId);
    expect(second.userTaskId).toBe(first.userTaskId);

    // Второй задачи не появилось: одна строка, одно событие приёма.
    expect(await store.requireTask(first.userTaskId)).not.toBeNull();
    const events = await store.history(first.userTaskId);
    expect(events.filter((e) => e.kind === 'task_accepted')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'task_accepted')[0]!.event_id).toBe(first.receipt.receiptId);
  });

  it('другой payload с тем же requestId -> conflict, задача не меняется', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-conflict');

    const first = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }));
    const before = await store.requireTask(first.userTaskId);

    await expect(
      intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId, inputItems: [{ text: 'другой текст' }] })),
    ).rejects.toBeInstanceOf(EnvelopeConflictError);

    const after = await store.requireTask(first.userTaskId);
    expect(after.revision).toBe(before.revision);
    expect(after.goal).toBe(before.goal);
    expect(await store.history(first.userTaskId)).toHaveLength(1);
  });

  it('scope ключа включает профиль: тот же requestId у другого профиля — другая задача', async () => {
    const { intake } = await setup();
    const requestId = nextId('req-scope');

    const a = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }));
    const b = await intake.admit(
      { principalId: 'sandbox-other-profile' },
      envelope({ requestId, profileId: 'profile-2' }),
    );

    expect(a.userTaskId).not.toBe(b.userTaskId);
    expect(b.duplicate).toBe(false);
  });

  it('userTaskId детерминирован от (profileId, requestId)', async () => {
    const id1 = await deriveUserTaskId('profile-1', 'req-x');
    const id2 = await deriveUserTaskId('profile-1', 'req-x');
    const id3 = await deriveUserTaskId('profile-2', 'req-x');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^ut-[0-9a-f]{20}$/);
  });

  it('stores workStyle durably and treats a changed launch choice as a different intake payload', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-style');
    const accepted = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId, workStyle: 'explore' }));
    const task = await store.requireTask(accepted.userTaskId);
    expect(JSON.parse(task.execution_policy_json!)).toEqual({ workStyle: 'explore', source: 'explicit' });
    await expect(intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId, workStyle: 'answer' })))
      .rejects.toBeInstanceOf(EnvelopeConflictError);
    const defaultAccepted = await intake.admit({ principalId: 'sandbox-local' }, envelope());
    expect(JSON.parse((await store.requireTask(defaultAccepted.userTaskId)).execution_policy_json!))
      .toEqual({ workStyle: 'auto', source: 'default' });
  });

  it('rejects unsupported workStyle before durable admission', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-style-invalid');
    await expect(intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId, workStyle: 'deep' })))
      .rejects.toThrow('workStyle must be explore, answer or auto');
    expect(await store.getTask(await deriveUserTaskId('profile-1', requestId))).toBeNull();
  });

  it('preserves an adapter-supplied default source for auto while validating its consistency', async () => {
    const { store, intake } = await setup();
    const accepted = await intake.admit({ principalId: 'sandbox-local' }, envelope({
      requestId: nextId('req-style-default'), workStyle: 'auto', workStyleSource: 'default',
    }));
    expect(JSON.parse((await store.requireTask(accepted.userTaskId)).execution_policy_json!))
      .toEqual({ workStyle: 'auto', source: 'default' });
    await expect(intake.admit({ principalId: 'sandbox-local' }, envelope({
      requestId: nextId('req-style-inconsistent'), workStyle: 'explore', workStyleSource: 'default',
    }))).rejects.toThrow('default workStyle must be auto');
  });
});

describe('Intake: профиль и права (AC-65)', () => {
  it('неизвестный принципал -> 401 ДО любой записи', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-401');
    await expect(intake.admit({ principalId: 'nobody' }, envelope({ requestId }))).rejects.toBeInstanceOf(
      PrincipalUnauthorizedError,
    );
    expect(await store.getTask(await deriveUserTaskId('profile-1', requestId))).toBeNull();
  });

  it('принципал без scope tasks:intake -> 403, задача не создана', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-403-scope');
    await expect(intake.admit({ principalId: 'sandbox-reader' }, envelope({ requestId }))).rejects.toBeInstanceOf(
      PrincipalForbiddenError,
    );
    expect(await store.getTask(await deriveUserTaskId('profile-1', requestId))).toBeNull();
  });

  it('принципал другого профиля -> 403 (подмена principal)', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-403-profile');
    await expect(
      intake.admit({ principalId: 'sandbox-other-profile' }, envelope({ requestId })),
    ).rejects.toBeInstanceOf(PrincipalForbiddenError);
    expect(await store.getTask(await deriveUserTaskId('profile-1', requestId))).toBeNull();
  });

  it('profileId из envelope должен совпадать с профилем принципала', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-403-declared');
    await expect(
      intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId, profileId: 'profile-2' })),
    ).rejects.toBeInstanceOf(PrincipalForbiddenError);
    expect(await store.getTask(await deriveUserTaskId('profile-1', requestId))).toBeNull();
  });
});

describe('Intake: атомарность и управляемый сбой', () => {
  it('сбой записи квитанции не оставляет задачу без квитанции (одна транзакция)', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-atomic');

    // Управляемый сбой: триггер отказывает вставку в task_events — вся транзакция
    // приёма должна откатиться, и задачи не должно существовать.
    // prepare().run() — одно целое statement: D1 exec() разбивает SQL по ';'
    // и тело триггера с его точкой с запятой он не примет.
    await env.DB
      .prepare(
        `CREATE TRIGGER intake_fail_receipt BEFORE INSERT ON task_events
         WHEN NEW.kind = 'task_accepted'
         BEGIN SELECT RAISE(ABORT, 'injected: receipt write failed'); END`,
      )
      .run();
    try {
      await expect(intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }))).rejects.toThrow(
        /injected: receipt write failed/,
      );
      expect(await store.getTask(await deriveUserTaskId('profile-1', requestId))).toBeNull();
      expect(await store.history(await deriveUserTaskId('profile-1', requestId))).toHaveLength(0);
    } finally {
      await env.DB.prepare(`DROP TRIGGER intake_fail_receipt`).run();
    }

    // После снятия сбоя повтор принимается ровно один раз.
    const ok = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }));
    expect(ok.duplicate).toBe(false);
    const again = await intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }));
    expect(again.duplicate).toBe(true);
    expect(await store.requireTask(ok.userTaskId)).not.toBeNull();
  });

  it('параллельный приём одного requestId: одна задача, одна квитанция', async () => {
    const { store, intake } = await setup();
    const requestId = nextId('req-race');

    const results = await Promise.all(
      Array.from({ length: 6 }, () => intake.admit({ principalId: 'sandbox-local' }, envelope({ requestId }))),
    );

    const created = results.filter((r) => !r.duplicate);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(5);
    for (const r of results) {
      expect(r.receipt.receiptId).toBe(created[0]!.receipt.receiptId);
      expect(r.userTaskId).toBe(created[0]!.userTaskId);
    }
    expect(await store.requireTask(created[0]!.userTaskId)).not.toBeNull();
    const events = await store.history(created[0]!.userTaskId);
    expect(events.filter((e) => e.kind === 'task_accepted')).toHaveLength(1);
  });
});

describe('Intake: логи (C12)', () => {
  it('отказ по правам логируется с profileId, requestId и причиной', async () => {
    const { intake } = await setup();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await expect(intake.admit({ principalId: 'sandbox-reader' }, envelope())).rejects.toBeInstanceOf(
        PrincipalForbiddenError,
      );
    } finally {
      spy.mockRestore();
    }
    const line = lines.find((l) => l.includes('intake.forbidden'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.profileId).toBe('profile-1');
    expect(parsed.requestId).toBeTruthy();
    expect(parsed.reason).toBe('scope_missing');
    expect(parsed.userTaskId ?? null).toBeNull();
  });
});
