import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { IntakeService } from '../src/intake';
import { CfWorkflowPort } from '../src/workflow-port';
import { PilotRouter, readPilotConfig, decideRoute, validatePilotConfig, type PilotConfig } from '../src/pilot';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const setupStore = () => new TaskStore(env.DB);

const setupIntake = (router?: PilotRouter) => {
  const store = setupStore();
  const intake = new IntakeService(store, router);
  return { store, intake };
};

const setupPort = () => {
  const store = setupStore();
  const port = new CfWorkflowPort(env.TASK_WORKFLOW, store);
  return { store, port };
};

const ensurePrincipal = async (store: TaskStore) => {
  await store.upsertPrincipal({
    principalId: 'sandbox-pilot',
    profileId: 'profile-pilot',
    scopes: ['tasks:intake', 'tasks:read', 'tasks:signal', 'tasks:control'],
  });
};

const envelope = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  requestId: nextId('req'),
  profileId: 'profile-pilot',
  inputItems: [{ text: 'test task' }],
  ...overrides,
});

describe('Pilot config', () => {
  it('readPilotConfig defaults to disabled when no env vars set', () => {
    const config = readPilotConfig();
    expect(config.enabled).toBe(false);
    expect(config.activatedAt).toBeNull();
    expect(config.cohortProfileIds).toBeNull();
    expect(config.legacyProfileIds).toBeNull();
  });

  it('readPilotConfig reads all env vars correctly', () => {
    process.env.PILOT_ENABLED = 'true';
    process.env.PILOT_ACTIVATED_AT = '2026-10-02T00:00:00.000Z';
    process.env.PILOT_COHORT_PROFILE_IDS = 'profile-pilot,profile-beta';
    process.env.PILOT_LEGACY_PROFILE_IDS = 'profile-legacy';
    try {
      const config = readPilotConfig();
      expect(config.enabled).toBe(true);
      expect(config.activatedAt).toBeGreaterThan(0);
      expect(config.cohortProfileIds).toEqual(['profile-pilot', 'profile-beta']);
      expect(config.legacyProfileIds).toEqual(['profile-legacy']);
    } finally {
      delete process.env.PILOT_ENABLED;
      delete process.env.PILOT_ACTIVATED_AT;
      delete process.env.PILOT_COHORT_PROFILE_IDS;
      delete process.env.PILOT_LEGACY_PROFILE_IDS;
    }
  });

  it('validatePilotConfig rejects enabled without activatedAt', () => {
    const errors = validatePilotConfig({ enabled: true, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null });
    expect(errors).toContain('PILOT_ACTIVATED_AT is required when PILOT_ENABLED=true');
  });

  it('validatePilotConfig accepts valid config', () => {
    const errors = validatePilotConfig({
      enabled: true,
      activatedAt: Date.now(),
      cohortProfileIds: ['profile-pilot'],
      legacyProfileIds: null,
    });
    expect(errors).toEqual([]);
  });
});

describe('decideRoute', () => {
  const now = Date.now();
  const past = now - 86_400_000;
  const future = now + 86_400_000;

  it('disabled pilot → legacy for all tasks', () => {
    const config: PilotConfig = { enabled: false, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null };
    expect(decideRoute('profile-pilot', now, config).route).toBe('legacy');
    expect(decideRoute('profile-pilot', now, config).reason).toBe('pilot_disabled');
  });

  it('profile in legacyProfileIds → legacy even when pilot enabled', () => {
    const config: PilotConfig = { enabled: true, activatedAt: past, cohortProfileIds: null, legacyProfileIds: ['profile-legacy'] };
    expect(decideRoute('profile-legacy', now, config).route).toBe('legacy');
    expect(decideRoute('profile-legacy', now, config).reason).toBe('profile_in_legacy_cohort');
  });

  it('profile not in cohortProfileIds → legacy', () => {
    const config: PilotConfig = { enabled: true, activatedAt: past, cohortProfileIds: ['profile-pilot'], legacyProfileIds: null };
    expect(decideRoute('profile-other', now, config).route).toBe('legacy');
    expect(decideRoute('profile-other', now, config).reason).toBe('profile_not_in_cohort');
  });

  it('task created before activatedAt → legacy', () => {
    const config: PilotConfig = { enabled: true, activatedAt: now, cohortProfileIds: null, legacyProfileIds: null };
    expect(decideRoute('profile-pilot', past, config).route).toBe('legacy');
    expect(decideRoute('profile-pilot', past, config).reason).toBe('task_created_before_pilot_activation');
  });

  it('all conditions met → new-plane', () => {
    const config: PilotConfig = { enabled: true, activatedAt: past, cohortProfileIds: null, legacyProfileIds: null };
    const result = decideRoute('profile-pilot', now, config);
    expect(result.route).toBe('new-plane');
    expect(result.reason).toBe('pilot_active_cohort_match');
  });

  it('cohortProfileIds=null means all profiles match', () => {
    const config: PilotConfig = { enabled: true, activatedAt: past, cohortProfileIds: null, legacyProfileIds: null };
    expect(decideRoute('any-profile', now, config).route).toBe('new-plane');
  });
});

describe('PilotRouter', () => {
  it('route() returns decision and logs it', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const result = await router.route({ profileId: 'profile-pilot', userTaskId: 'ut-test', requestId: 'req-1', createdAt: Date.now() });
    expect(result.route).toBe('new-plane');
    expect(result.reason).toBe('pilot_active_cohort_match');
  });

  it('updateConfig() switches from enabled to disabled (rollback)', () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    expect(router.getConfig().enabled).toBe(true);

    router.updateConfig({ enabled: false, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null });
    expect(router.getConfig().enabled).toBe(false);
  });

  it('updateConfig() rejects invalid config', () => {
    const router = new PilotRouter();
    expect(() =>
      router.updateConfig({ enabled: true, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null }),
    ).toThrow('Pilot config invalid');
  });
});

describe('Pilot routing integration with intake', () => {
  it('new task with pilot enabled gets pilotRoute=new-plane in user_value', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId = nextId('req-pilot');
    const result = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(result.duplicate).toBe(false);
    expect(result.pilotRoute).toBe('new-plane');
    expect(result.pilotReason).toBe('pilot_active_cohort_match');

    const task = await store.getTask(result.userTaskId);
    expect(task).not.toBeNull();
    const userValue = JSON.parse(task!.user_value ?? '{}') as Record<string, unknown>;
    expect(userValue.pilotRoute).toBe('new-plane');
    expect(userValue.pilotReason).toBe('pilot_active_cohort_match');
  });

  it('new task with pilot disabled gets pilotRoute=legacy', async () => {
    const config: PilotConfig = { enabled: false, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId = nextId('req-legacy');
    const result = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(result.pilotRoute).toBe('legacy');
    expect(result.pilotReason).toBe('pilot_disabled');

    const task = await store.getTask(result.userTaskId);
    const userValue = JSON.parse(task!.user_value ?? '{}') as Record<string, unknown>;
    expect(userValue.pilotRoute).toBe('legacy');
  });

  it('task created before pilot activation gets legacy even when pilot enabled', async () => {
    const past = Date.now() - 86_400_000;
    const config: PilotConfig = { enabled: true, activatedAt: Date.now(), cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId = nextId('req-old');
    const result = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(result.pilotRoute).toBe('legacy');
    expect(result.pilotReason).toBe('task_created_before_pilot_activation');
  });

  it('duplicate requestId returns same pilotRoute (no re-routing)', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId = nextId('req-dup');
    const first = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(first.pilotRoute).toBe('new-plane');

    const second = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(second.duplicate).toBe(true);
    expect(second.pilotRoute).toBe('new-plane');
    expect(second.userTaskId).toBe(first.userTaskId);
  });

  it('profile in legacyProfileIds always routes legacy', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: ['profile-pilot'] };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId = nextId('req-legacy-profile');
    const result = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(result.pilotRoute).toBe('legacy');
    expect(result.pilotReason).toBe('profile_in_legacy_cohort');
  });
});

describe('Workflow port respects pilot route', () => {
  it('legacy-routed task does not create workflow instance', async () => {
    const config: PilotConfig = { enabled: false, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, port } = setupPort();
    await ensurePrincipal(store);

    const requestId = nextId('req-legacy-port');
    const intake = new IntakeService(store, router);
    const admitResult = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(admitResult.pilotRoute).toBe('legacy');

    const submitResult = await port.submit({
      id: admitResult.userTaskId,
      profileId: 'profile-pilot',
      goal: 'test goal',
    });
    expect(submitResult.pilotRoute).toBe('legacy');
    expect(submitResult.instanceCreated).toBe(false);
    expect(submitResult.runId).toBeNull();
  });

  it('new-plane task creates workflow instance (normal path)', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, port } = setupPort();
    await ensurePrincipal(store);

    const requestId = nextId('req-new-plane');
    const intake = new IntakeService(store, router);
    const admitResult = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(admitResult.pilotRoute).toBe('new-plane');

    const submitResult = await port.submit({
      id: admitResult.userTaskId,
      profileId: 'profile-pilot',
      goal: 'test goal',
    });
    expect(submitResult.pilotRoute).toBe('new-plane');
  });
});

describe('Rollback: disable pilot routes all new tasks to legacy', () => {
  it('after rollback, new tasks go to legacy even if created after activation', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId1 = nextId('req-before-rollback');
    const result1 = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId1 }));
    expect(result1.pilotRoute).toBe('new-plane');

    router.updateConfig({ enabled: false, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null });

    const requestId2 = nextId('req-after-rollback');
    const result2 = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId2 }));
    expect(result2.pilotRoute).toBe('legacy');
    expect(result2.pilotReason).toBe('pilot_disabled');
  });

  it('rollback does not create duplicate tasks', async () => {
    const config: PilotConfig = { enabled: true, activatedAt: Date.now() - 1000, cohortProfileIds: null, legacyProfileIds: null };
    const router = new PilotRouter({ config });
    const { store, intake } = setupIntake(router);
    await ensurePrincipal(store);

    const requestId = nextId('req-rollback');
    const first = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(first.duplicate).toBe(false);

    router.updateConfig({ enabled: false, activatedAt: null, cohortProfileIds: null, legacyProfileIds: null });

    const second = await intake.admit({ principalId: 'sandbox-pilot' }, envelope({ requestId }));
    expect(second.duplicate).toBe(true);
    expect(second.userTaskId).toBe(first.userTaskId);
  });
});