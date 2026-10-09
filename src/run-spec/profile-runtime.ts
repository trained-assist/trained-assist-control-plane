import { runnerAdapterOf, type RunnerApiAdapter, type RunnerApiServiceBinding } from '../runner-adapter';
import { RunSpecMappingError, runSpecPolicyOf, type RunSpecPolicy } from './run-spec';
import { registryFixtureMcpSpec } from '../router/registry-test-mcp';

export const TELEGRAM_UX_PROFILE = 'integration-telegram-ux-v1';

export class ProfileRuntimeConfigurationError extends RunSpecMappingError {
  constructor() {
    super('Invalid or incomplete trusted profile runtime configuration', 'RUN_SPEC_PROFILE_OVERRIDES');
  }
}

export interface ProfileRuntimeBindings {
  RUNNER_API_SERVICE?: RunnerApiServiceBinding;
  RUNNER_API_KEY?: string;
  RUNNER_API_KEY_TELEGRAM_UX?: string;
  RUNNER_API_KEY_AGENT_API?: string;
  RUNNER_API_ENGINE_SELECTION?: string;
  RUNNER_PROFILE_DELEGATION_SECRET?: string;
  RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?: string;
  RUNNER_PROFILE_DELEGATION_TENANT_ID?: string;
  RUN_SPEC_PROFILE_OVERRIDES?: string;
  MCP_TEST_AUTH_TOKEN?: string;
}

export function resolveProfileRuntime(
  env: ProfileRuntimeBindings & Record<string, unknown>,
  durableProfileId: string,
): { policy: RunSpecPolicy; adapter: RunnerApiAdapter | null; runnerApiConfigured: boolean } {
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
      const keys = Object.keys(entry).sort().join(',');
      if (!['policy', 'hostMcpBinding,policy', 'policy,runnerKeyBinding', 'hostMcpBinding,policy,runnerKeyBinding'].includes(keys)
        || entry.policy !== 'generic_text_v1') return fail();
      if (entry.runnerKeyBinding !== undefined && entry.runnerKeyBinding !== 'RUNNER_API_KEY_TELEGRAM_UX') return fail();
      if (entry.hostMcpBinding !== undefined && entry.hostMcpBinding !== 'registry-mcp-test-160-read') return fail();
    }
  }
  const policy = runSpecPolicyOf(env as Record<string, string | undefined>);
  // An orphaned secret is inert; Agent API selection remains explicit.
  // Partial principal/tenant identity still fails closed instead of falling back.
  const delegationIdentityBindings = [env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID,
    env.RUNNER_PROFILE_DELEGATION_TENANT_ID];
  const agentApiMode = env.RUNNER_API_ENGINE_SELECTION === 'agent_api';
  const hasDelegationIdentity = delegationIdentityBindings.some(value => value !== undefined)
    || env.RUNNER_PROFILE_DELEGATION_SECRET !== undefined;
  if (agentApiMode && !hasDelegationIdentity && durableProfileId === TELEGRAM_UX_PROFILE) {
    const profileOverride = overrides[durableProfileId] as Record<string, unknown> | undefined;
    if (!profileOverride || !env.RUNNER_API_SERVICE || !env.RUNNER_API_KEY_TELEGRAM_UX?.trim()
      || env.RUNNER_API_KEY_TELEGRAM_UX === env.RUNNER_API_KEY) return fail();
    const adapter = runnerAdapterOf({ RUNNER_API_SERVICE: env.RUNNER_API_SERVICE,
      RUNNER_API_KEY: env.RUNNER_API_KEY_TELEGRAM_UX, RUNNER_API_ENGINE_SELECTION: 'agent_api' });
    if (!adapter) return fail();
    const hostMcpEnabled = profileOverride.hostMcpBinding === 'registry-mcp-test-160-read';
    if (hostMcpEnabled && !env.MCP_TEST_AUTH_TOKEN?.trim()) return fail();
    return { policy: { ...policy, outputs: [], inputRefs: [], repository: null,
      mcp: hostMcpEnabled ? registryFixtureMcpSpec() : null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') },
    adapter, runnerApiConfigured: true };
  }
  if (agentApiMode || delegationIdentityBindings.some(value => value !== undefined)) {
    const profileOverride = durableProfileId === TELEGRAM_UX_PROFILE
      ? overrides[durableProfileId] as Record<string, unknown> | undefined : undefined;
    if (!agentApiMode || !env.RUNNER_PROFILE_DELEGATION_SECRET?.trim() || !env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?.trim()
      || !env.RUNNER_PROFILE_DELEGATION_TENANT_ID?.trim() || !env.RUNNER_API_SERVICE
      || !env.RUNNER_API_KEY_AGENT_API?.trim() || env.RUNNER_API_KEY_AGENT_API === env.RUNNER_API_KEY
      || env.RUNNER_API_KEY_AGENT_API === env.RUNNER_API_KEY_TELEGRAM_UX
      || !durableProfileId.trim()) return fail();
    const adapter = runnerAdapterOf({ RUNNER_API_SERVICE: env.RUNNER_API_SERVICE, RUNNER_API_KEY: env.RUNNER_API_KEY_AGENT_API,
      RUNNER_API_ENGINE_SELECTION: 'agent_api', RUNNER_PROFILE_DELEGATION_SECRET: env.RUNNER_PROFILE_DELEGATION_SECRET,
      RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID: env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID,
      RUNNER_PROFILE_DELEGATION_TENANT_ID: env.RUNNER_PROFILE_DELEGATION_TENANT_ID, RUNNER_PROFILE_DELEGATED_ID: durableProfileId });
    if (!adapter) return fail();
    if (durableProfileId === TELEGRAM_UX_PROFILE) {
      const profileOverride = overrides[durableProfileId] as Record<string, unknown> | undefined;
      const hostMcpEnabled = profileOverride?.hostMcpBinding === 'registry-mcp-test-160-read';
      if (hostMcpEnabled && !env.MCP_TEST_AUTH_TOKEN?.trim()) return fail();
      return { policy: { ...policy, repository: null, outputs: [], inputRefs: [],
        mcp: hostMcpEnabled ? registryFixtureMcpSpec() : null,
        envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') }, adapter, runnerApiConfigured: true };
    }
    return { policy: { ...policy, repository: null, outputs: [], inputRefs: [], mcp: null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') }, adapter, runnerApiConfigured: true };
  }
  if (durableProfileId !== TELEGRAM_UX_PROFILE) return { policy, adapter: runnerAdapterOf(env),
    runnerApiConfigured: Boolean(env.RUNNER_API_SERVICE) };
  const profileOverride = overrides[durableProfileId] as Record<string, unknown> | undefined;
  if (!profileOverride || !Object.hasOwn(overrides, durableProfileId) || !env.RUNNER_API_SERVICE
    || !env.RUNNER_API_KEY_TELEGRAM_UX?.trim()
    || env.RUNNER_API_KEY_TELEGRAM_UX === env.RUNNER_API_KEY) return fail();
  const hostMcpEnabled = profileOverride.hostMcpBinding === 'registry-mcp-test-160-read';
  if (hostMcpEnabled && !env.MCP_TEST_AUTH_TOKEN?.trim()) return fail();
  return {
    // This API principal is bound to its isolated test repository at Runner.
    // Sending RUN_SPEC_REPOSITORY would try to override that authenticated binding.
    policy: { ...policy, outputs: [], inputRefs: [], repository: null, mcp: hostMcpEnabled ? registryFixtureMcpSpec() : null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') },
    adapter: runnerAdapterOf({ RUNNER_API_SERVICE: env.RUNNER_API_SERVICE, RUNNER_API_KEY: env.RUNNER_API_KEY_TELEGRAM_UX,
      RUNNER_API_ENGINE_SELECTION: env.RUNNER_API_ENGINE_SELECTION }),
    runnerApiConfigured: true,
  };
}
