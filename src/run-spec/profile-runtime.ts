import { runnerAdapterOf, type RunnerApiAdapter } from '../runner-adapter';
import { RunSpecMappingError, runSpecPolicyOf, type RunSpecPolicy } from './run-spec';

export const TELEGRAM_UX_PROFILE = 'integration-telegram-ux-v1';

export class ProfileRuntimeConfigurationError extends RunSpecMappingError {
  constructor() {
    super('Invalid or incomplete trusted profile runtime configuration', 'RUN_SPEC_PROFILE_OVERRIDES');
  }
}

export interface ProfileRuntimeBindings {
  RUNNER_API_URL?: string;
  RUNNER_API_KEY?: string;
  RUNNER_API_KEY_TELEGRAM_UX?: string;
  RUN_SPEC_PROFILE_OVERRIDES?: string;
}

export function resolveProfileRuntime(
  env: ProfileRuntimeBindings & Record<string, string | undefined>,
  durableProfileId: string,
): { policy: RunSpecPolicy; adapter: RunnerApiAdapter | null } {
  const fail = (): never => {
    throw new ProfileRuntimeConfigurationError();
  };
  let overrides: Record<string, unknown> = {};
  if (env.RUN_SPEC_PROFILE_OVERRIDES !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.RUN_SPEC_PROFILE_OVERRIDES); } catch { return fail(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
    overrides = parsed as Record<string, unknown>;
    for (const [profileId, raw] of Object.entries(overrides)) {
      if (profileId !== TELEGRAM_UX_PROFILE || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
      const entry = raw as Record<string, unknown>;
      if (Object.keys(entry).sort().join(',') !== 'policy,runnerKeyBinding'
        || entry.policy !== 'generic_text_v1' || entry.runnerKeyBinding !== 'RUNNER_API_KEY_TELEGRAM_UX') return fail();
    }
  }
  const policy = runSpecPolicyOf(env);
  if (durableProfileId !== TELEGRAM_UX_PROFILE) return { policy, adapter: runnerAdapterOf(env) };
  if (!Object.hasOwn(overrides, durableProfileId) || !env.RUNNER_API_URL
    || !env.RUNNER_API_KEY_TELEGRAM_UX?.trim()
    || env.RUNNER_API_KEY_TELEGRAM_UX === env.RUNNER_API_KEY) return fail();
  return {
    policy: { ...policy, outputs: [], inputRefs: [], mcp: null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') },
    adapter: runnerAdapterOf({ RUNNER_API_URL: env.RUNNER_API_URL, RUNNER_API_KEY: env.RUNNER_API_KEY_TELEGRAM_UX }),
  };
}
