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
  RUNNER_API_KEY_AGENT_API?: string;
  RUNNER_API_ENGINE_SELECTION?: string;
  RUNNER_PROFILE_DELEGATION_SECRET?: string;
  RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?: string;
  RUNNER_PROFILE_DELEGATION_TENANT_ID?: string;
  RUNNER_API_FETCH?: typeof fetch;
  RUN_SPEC_PROFILE_OVERRIDES?: string;
  MCP_TEST_AUTH_TOKEN?: string;
}

function runnerRuntimeBindings(env: ProfileRuntimeBindings & Record<string, string | undefined>) {
  const service = (env as ProfileRuntimeBindings & { RUNNER_API_SERVICE?: { fetch: typeof fetch } }).RUNNER_API_SERVICE;
  return { env: env as ProfileRuntimeBindings, fetch: service ? service.fetch.bind(service) as typeof fetch : undefined };
}

export function profileRunnerUrlOf(
  env: ProfileRuntimeBindings & Record<string, string | undefined>,
  durableProfileId: string,
): string | null {
  const runtime = runnerRuntimeBindings(env);
  if (durableProfileId !== TELEGRAM_UX_PROFILE) return runtime.env.RUNNER_API_URL?.trim() || null;
  try {
    const overrides = JSON.parse(runtime.env.RUN_SPEC_PROFILE_OVERRIDES ?? '{}') as Record<string, unknown>;
    const raw = overrides[durableProfileId];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entry = raw as Record<string, unknown>;
      if (Object.hasOwn(entry, 'runnerUrlBinding')
        || entry.policy !== 'generic_text_v1'
        || !['policy', 'hostMcpBinding,policy', 'policy,runnerKeyBinding', 'hostMcpBinding,policy,runnerKeyBinding', 'hostMcpBinding,policy,runnerKeyBinding']
          .includes(Object.keys(entry).sort().join(','))) return null;
    }
  } catch { /* resolveProfileRuntime returns the sanitized configuration error */ }
  return runtime.env.RUNNER_API_URL?.trim() || null;
}

export function resolveProfileRuntime(
  env: ProfileRuntimeBindings & Record<string, string | undefined>,
  durableProfileId: string,
): { policy: RunSpecPolicy; adapter: RunnerApiAdapter | null; runnerApiUrl: string | null } {
  const resolved = runnerRuntimeBindings(env);
  env = resolved.env as ProfileRuntimeBindings & Record<string, string | undefined>;
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
  const policy = runSpecPolicyOf(env);
  // An orphaned secret is inert; Agent API selection remains explicit.
  // Partial principal/tenant identity still fails closed instead of falling back.
  const delegationIdentityBindings = [env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID,
    env.RUNNER_PROFILE_DELEGATION_TENANT_ID];
  const agentApiMode = env.RUNNER_API_ENGINE_SELECTION === 'agent_api';
  if (agentApiMode || delegationIdentityBindings.some(value => value !== undefined)) {
    const profileOverride = durableProfileId === TELEGRAM_UX_PROFILE
      ? overrides[durableProfileId] as Record<string, unknown> | undefined : undefined;
    const runnerUrl = env.RUNNER_API_URL?.trim();
    if (!agentApiMode || !env.RUNNER_PROFILE_DELEGATION_SECRET?.trim() || !env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?.trim()
      || !env.RUNNER_PROFILE_DELEGATION_TENANT_ID?.trim() || !runnerUrl
      || !env.RUNNER_API_KEY_AGENT_API?.trim() || env.RUNNER_API_KEY_AGENT_API === env.RUNNER_API_KEY
      || env.RUNNER_API_KEY_AGENT_API === env.RUNNER_API_KEY_TELEGRAM_UX
      || !durableProfileId.trim()) return fail();
    const adapter = runnerAdapterOf({ RUNNER_API_URL: runnerUrl, RUNNER_API_KEY: env.RUNNER_API_KEY_AGENT_API,
      RUNNER_API_ENGINE_SELECTION: 'agent_api', RUNNER_PROFILE_DELEGATION_SECRET: env.RUNNER_PROFILE_DELEGATION_SECRET,
      RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID: env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID,
      RUNNER_PROFILE_DELEGATION_TENANT_ID: env.RUNNER_PROFILE_DELEGATION_TENANT_ID, RUNNER_PROFILE_DELEGATED_ID: durableProfileId,
      RUNNER_API_FETCH: resolved.fetch });
    if (!adapter) return fail();
    if (durableProfileId === TELEGRAM_UX_PROFILE) {
      const profileOverride = overrides[durableProfileId] as Record<string, unknown> | undefined;
      const hostMcpEnabled = profileOverride?.hostMcpBinding === 'registry-mcp-test-160-read';
      if (hostMcpEnabled && !env.MCP_TEST_AUTH_TOKEN?.trim()) return fail();
      return { policy: { ...policy, repository: null, outputs: [], inputRefs: [],
        mcp: hostMcpEnabled ? registryFixtureMcpSpec() : null,
        envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') }, adapter, runnerApiUrl: runnerUrl ?? null };
    }
    return { policy: { ...policy, repository: null, outputs: [], inputRefs: [], mcp: null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') }, adapter, runnerApiUrl: runnerUrl ?? null };
  }
  if (durableProfileId !== TELEGRAM_UX_PROFILE) return { policy, adapter: runnerAdapterOf(env),
    runnerApiUrl: profileRunnerUrlOf(env, durableProfileId) };
  const profileOverride = overrides[durableProfileId] as Record<string, unknown> | undefined;
  const runnerUrl = env.RUNNER_API_URL?.trim();
    if (!profileOverride || !Object.hasOwn(overrides, durableProfileId) || !runnerUrl
    || !env.RUNNER_API_KEY_TELEGRAM_UX?.trim()
    || env.RUNNER_API_KEY_TELEGRAM_UX === env.RUNNER_API_KEY) return fail();
  const hostMcpEnabled = profileOverride.hostMcpBinding === 'registry-mcp-test-160-read';
  if (hostMcpEnabled && !env.MCP_TEST_AUTH_TOKEN?.trim()) return fail();
  return {
    // This API principal is bound to its isolated test repository at Runner.
    // Sending RUN_SPEC_REPOSITORY would try to override that authenticated binding.
    policy: { ...policy, outputs: [], inputRefs: [], repository: null, mcp: hostMcpEnabled ? registryFixtureMcpSpec() : null,
      envAllowlist: policy.envAllowlist.filter(name => name === 'LLM_LADDER_TOKEN') },
    adapter: runnerAdapterOf({ RUNNER_API_URL: runnerUrl, RUNNER_API_KEY: env.RUNNER_API_KEY_TELEGRAM_UX,
      RUNNER_API_ENGINE_SELECTION: env.RUNNER_API_ENGINE_SELECTION, RUNNER_API_FETCH: resolved.fetch }),
    runnerApiUrl: runnerUrl,
  };
}
