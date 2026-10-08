import { runnerAdapterOf, type RunnerApiAdapter } from '../runner-adapter';
import { RunSpecMappingError, runSpecPolicyOf, type RunSpecPolicy } from './run-spec';
import { registryFixtureMcpSpec } from '../router/registry-test-mcp';

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
  MCP_TEST_AUTH_TOKEN?: string;
  RUNNER_PROFILE_DELEGATION_SECRET?: string;
  RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?: string;
  RUNNER_API_PROFILE_TENANT_ID?: string;
}

export function resolveProfileRuntime(
  env: ProfileRuntimeBindings & Record<string, string | undefined>,
  durableProfileId: string,
): { policy: RunSpecPolicy; adapter: RunnerApiAdapter | null } {
  const fail = (): never => {
    throw new ProfileRuntimeConfigurationError();
  };
  const delegatedProfile = /^prof-[0-9a-f-]{36}$/.test(durableProfileId);
  if (delegatedProfile) {
    if (!env.RUNNER_PROFILE_DELEGATION_SECRET?.trim() || !env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?.trim()
      || !env.RUNNER_API_PROFILE_TENANT_ID?.trim()) return fail();
    const base = resolveProfileRuntime(env, TELEGRAM_UX_PROFILE);
    return {
      policy: { ...base.policy, repository: null },
      adapter: runnerAdapterOf({ RUNNER_API_URL: env.RUNNER_API_URL, RUNNER_API_KEY: env.RUNNER_API_KEY_TELEGRAM_UX,
        RUNNER_PROFILE_DELEGATION_SECRET: env.RUNNER_PROFILE_DELEGATION_SECRET,
        RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID: env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID,
        RUNNER_PROFILE_DELEGATION_TENANT_ID: env.RUNNER_API_PROFILE_TENANT_ID,
        RUNNER_PROFILE_DELEGATED_ID: durableProfileId }),
    };
  }
  let overrides: Record<string, unknown> = {};
  if (env.RUN_SPEC_PROFILE_OVERRIDES !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.RUN_SPEC_PROFILE_OVERRIDES); } catch { return fail(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
    overrides = parsed as Record<string, unknown>;
    for (const [profileId, raw] of Object.entries(overrides)) {
      if (profileId !== TELEGRAM_UX_PROFILE || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
      const entry = raw as Record<string, unknown>;
      if (!['policy,runnerKeyBinding', 'hostMcpBinding,policy,runnerKeyBinding'].includes(Object.keys(entry).sort().join(','))
        || entry.policy !== 'generic_text_v1' || entry.runnerKeyBinding !== 'RUNNER_API_KEY_TELEGRAM_UX') return fail();
      if (entry.hostMcpBinding !== undefined && entry.hostMcpBinding !== 'registry-mcp-test-160-read') return fail();
    }
  }
  const policy = runSpecPolicyOf(env);
  if (durableProfileId !== TELEGRAM_UX_PROFILE) return { policy, adapter: runnerAdapterOf(env) };
  if (!Object.hasOwn(overrides, durableProfileId) || !env.RUNNER_API_URL
    || !env.RUNNER_API_KEY_TELEGRAM_UX?.trim()
    || env.RUNNER_API_KEY_TELEGRAM_UX === env.RUNNER_API_KEY) return fail();
  const profileOverride = overrides[durableProfileId] as Record<string, unknown>;
  const hostMcpEnabled = profileOverride.hostMcpBinding === 'registry-mcp-test-160-read';
  if (hostMcpEnabled && !env.MCP_TEST_AUTH_TOKEN?.trim()) return fail();
  return {
    // This API principal is bound to its isolated test repository at Runner.
    // Sending RUN_SPEC_REPOSITORY would try to override that authenticated binding.
    policy: { ...policy, outputs: [], inputRefs: [], repository: null, mcp: hostMcpEnabled ? registryFixtureMcpSpec() : null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') },
    adapter: runnerAdapterOf({ RUNNER_API_URL: env.RUNNER_API_URL, RUNNER_API_KEY: env.RUNNER_API_KEY_TELEGRAM_UX }),
  };
}
