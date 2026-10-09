// Own-API dogfood (#23), шаг 2: versioned mapping Task input → RunSpec.
//  - хост владеет cwd/envAllowlist/outputs/mcp/repository/result/limits;
//  - клиент владеет только сообщением и разрешёнными вложениями;
//  - форма запроса проверяется локально по контракту Runner'а.
import {
  RUN_SPEC_VERSION,
  RunSpecMappingError,
  buildRunSpec,
  defaultRunSpecPolicy,
  runSpecPolicyOf,
  toSubmitRequest,
  untransmittedRunSpecFields,
  validateRunSpec,
  type RunSpec,
  type RunSpecInput,
  type RunSpecPolicy,
} from '../src/run-spec/run-spec';
import { RunnerApiAdapter } from '../src/runner-adapter';
import { describe, expect, it } from 'vitest';

const baseInput = {
  userTaskId: 'ut-abc123',
  profileId: 'profile-1',
  conversationId: 'conv-1',
  ownerGeneration: 1,
  engineName: 'opencode',
  prompt: 'собери отчёт',
  refs: [],
  instructions: null,
  attemptRunId: 'attempt-1',
  timeoutMs: 120_000,
};

const policy: RunSpecPolicy = defaultRunSpecPolicy();

describe('run-spec: сборка по умолчанию', () => {
  it('собирает RunSpec с хостовыми полями и версией контракта', () => {
    const built = buildRunSpec(baseInput, policy);

    expect(built.version).toBe(RUN_SPEC_VERSION);
    expect(built.runId).toBe('run_ut-abc123_1');
    expect(built.jobId).toBe('job_ut-abc123');
    expect(built.operationId).toBe('op_attempt-1');

    const spec = built.spec;
    expect(spec.contractVersion).toBe(1);
    expect(spec.userTaskId).toBe('ut-abc123');
    expect(spec.profileId).toBe('profile-1');
    expect(spec.conversationId).toBe('conv-1');
    expect(spec.ownerGeneration).toBe(1);
    expect(spec.engine).toEqual({ name: 'opencode', adapterVersion: '1' });
    // Хостовое: клиент его не передаёт.
    expect(spec.cwd).toBe('/workspace');
    expect(spec.envAllowlist).toEqual([]);
    expect(spec.outputs).toBeUndefined();
    expect(spec.mcp).toBeUndefined();
    expect(spec.repository).toBeUndefined();
    expect(spec.result).toBeUndefined();
    expect(spec.traceId).toBe('attempt-1');
    expect(spec.input).toEqual({ inlinePrompt: 'собери отчёт' });
    expect(validateRunSpec(spec).ok).toBe(true);
  });

  it('разрешённые вложения едут в input.refs, а не теряются', () => {
    const built = buildRunSpec({ ...baseInput, refs: [{ ref: 'artifact://a.md' }, { ref: 'artifact://b.md', version: 'v3' }] }, policy);
    expect(built.spec.input?.refs).toEqual([{ ref: 'artifact://a.md' }, { ref: 'artifact://b.md', version: 'v3' }]);
  });

  it('snapshotId едет в input.refs: ран материализует байты снимка (Runner #52 шаг 1)', () => {
    const built = buildRunSpec({ ...baseInput, refs: [{ ref: 'snap-df1c902a', snapshotId: 'snap-df1c902a' }] }, policy);
    expect(built.spec.input?.refs).toEqual([{ ref: 'snap-df1c902a', snapshotId: 'snap-df1c902a' }]);
    expect(validateRunSpec(built.spec).ok).toBe(true);
  });

  it('passes the CP-pinned ingress manifest separately from workspace snapshot refs', () => {
    const built = buildRunSpec({ ...baseInput, inputManifest: {
      manifestRef: 'cp-input-manifest:ut-abc123', manifestVersion: 'a'.repeat(64),
    } }, policy);
    expect(built.spec.ingressManifest).toEqual({
      contractVersion: 1,
      manifestRef: 'cp-input-manifest:ut-abc123',
      manifestVersion: 'a'.repeat(64),
      userTaskId: 'ut-abc123',
      profileId: 'profile-1',
      runId: 'run_ut-abc123_1',
      ownerGeneration: 1,
    });
    expect(built.spec.input?.refs).toBeUndefined();
    expect(toSubmitRequest(built.spec).ingressManifest).toEqual({
      contractVersion: 1,
      manifestRef: 'cp-input-manifest:ut-abc123',
      manifestVersion: 'a'.repeat(64),
    });
    expect(validateRunSpec(built.spec).ok).toBe(true);
  });

  it('rejects an ingress manifest combined with generic refs or an unpinned task', () => {
    const inputManifest = { manifestRef: 'cp-input-manifest:ut-abc123', manifestVersion: 'a'.repeat(64) };
    expect(() => buildRunSpec({ ...baseInput, inputManifest, refs: [{ ref: 'snapshot-1', snapshotId: 'snapshot-1' }] }, policy)).toThrow(/cannot be combined/);
    expect(() => buildRunSpec({ ...baseInput, inputManifest: { ...inputManifest, manifestRef: 'cp-input-manifest:foreign' } }, policy)).toThrow(/task-scoped/);
  });

  it('snapshotId вне алфавита отклоняется: снимок — не произвольная строка', () => {
    expect(() => buildRunSpec({ ...baseInput, refs: [{ ref: 'snap-1', snapshotId: '../escape' }] }, policy)).toThrow(RunSpecMappingError);
    expect(() => buildRunSpec({ ...baseInput, refs: [{ ref: 'snap-1', snapshotId: '' }] }, policy)).toThrow(RunSpecMappingError);
  });

  it('пустой prompt отклоняется: задача без сообщения — не задача', () => {
    expect(() => buildRunSpec({ ...baseInput, prompt: '   ' }, policy)).toThrow(RunSpecMappingError);
  });

  it('preserves multiline goal and full instructions without normalization', () => {
    const prompt = '  первая\r\nвторая\tтретья  ';
    const instructions = 'Original context:\n```\n  keep whitespace\n```\n';
    const built = buildRunSpec({ ...baseInput, prompt, instructions }, policy);
    expect(built.promptNormalized).toBe(false);
    expect(toSubmitRequest(built.spec).input?.inlinePrompt).toBe(prompt);
    expect(toSubmitRequest(built.spec).instructions).toBe(instructions.trim());
    expect(validateRunSpec(built.spec).ok).toBe(true);
  });

  it('rejects oversized combined context and unsupported controls rather than truncating', () => {
    expect(() => buildRunSpec({ ...baseInput, instructions: 'x'.repeat(100_000) }, policy)).toThrow(RunSpecMappingError);
    expect(() => buildRunSpec({ ...baseInput, prompt: 'before\x00after' }, policy)).toThrow(RunSpecMappingError);
    expect(() => buildRunSpec({ ...baseInput, instructions: 'before\x7fafter' }, policy)).toThrow(RunSpecMappingError);
  });

  it('runId стабилен для той же задачи и поколения — идемпотентность на стороне хоста', () => {
    const a = buildRunSpec(baseInput, policy);
    const b = buildRunSpec(baseInput, policy);
    expect(a.runId).toBe(b.runId);
    expect(buildRunSpec({ ...baseInput, ownerGeneration: 2 }, policy).runId).toBe('run_ut-abc123_2');
  });
});

describe('run-spec: хостовая политика из bindings', () => {
  it('по умолчанию — минимальная и непривилегированная', () => {
    const p = runSpecPolicyOf({});
    expect(p).toEqual({
      cwd: '/workspace',
      envAllowlist: [],
      outputs: [],
      mcp: null,
      repository: null,
      resultDestinationRef: null,
      maxOutputBytes: null,
      inputRefs: [],
      budget: null,
      budgetPolicies: {},
    });
  });

  it('выходной манифест, MCP и snapshot binding приходят из bindings, а не от клиента', () => {
    const p = runSpecPolicyOf({
      RUN_SPEC_OUTPUTS: JSON.stringify([{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }]),
      RUN_SPEC_MCP: JSON.stringify({
        servers: [
          {
            serverId: 'fs',
            transport: 'stdio',
            command: 'node',
            args: ['server.mjs'],
            allowedTools: ['read_file'],
          },
        ],
      }),
      RUN_SPEC_REPOSITORY: JSON.stringify({ fullName: 'owner/name' }),
      RUN_SPEC_RESULT_DESTINATION_REF: 'r2://sandbox/task-outputs',
      RUN_SPEC_MAX_OUTPUT_BYTES: '1048576',
    });

    const built = buildRunSpec(baseInput, p);
    expect(built.spec.outputs).toEqual([{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }]);
    expect(built.spec.mcp?.servers).toHaveLength(1);
    expect(built.spec.repository).toEqual({ fullName: 'owner/name' });
    expect(built.spec.result).toEqual({ destinationRef: 'r2://sandbox/task-outputs' });
    expect(built.spec.limits.maxOutputBytes).toBe(1_048_576);
    expect(validateRunSpec(built.spec).ok).toBe(true);
  });

  it('envAllowlist принимает только имена переменных, не значения', () => {
    expect(() => runSpecPolicyOf({ RUN_SPEC_ENV_ALLOWLIST: 'A=1' })).toThrow(RunSpecMappingError);
    expect(runSpecPolicyOf({ RUN_SPEC_ENV_ALLOWLIST: 'A, B_C' }).envAllowlist).toEqual(['A', 'B_C']);
  });

  it('parses a strict host-owned token budget policy and rejects caller attempts to replace it', () => {
    const enforcement = { provider: 'ladder', policyId: 'sandbox-test-v1', maxInputTokens: 12000, maxOutputTokens: 2000, maxTotalTokens: 20000 };
    const hostPolicy = runSpecPolicyOf({ RUN_SPEC_BUDGET_POLICIES: JSON.stringify({ 'profile-1': enforcement }) });
    const selectedPolicy = { ...hostPolicy, budget: hostPolicy.budgetPolicies?.['profile-1'] };
    const built = buildRunSpec(baseInput, selectedPolicy);
    expect(built.spec.budget).toEqual({ correlationRef: baseInput.userTaskId, approved: true, enforcement });
    expect(toSubmitRequest(built.spec).budget).toEqual(built.spec.budget);
    expect(validateRunSpec(built.spec).ok).toBe(true);

    const injected = { ...baseInput, budget: { correlationRef: 'attacker', approved: true, enforcement } } as unknown as RunSpecInput;
    expect(() => buildRunSpec(injected, selectedPolicy)).toThrow(/host-owned field/);
  });

  it.each([
    { provider: 'ladder', policyId: 'sandbox-test-v1', maxInputTokens: 0, maxOutputTokens: 2000, maxTotalTokens: 10000 },
    { provider: 'ladder', policyId: 'sandbox-test-v1', maxInputTokens: 12000, maxOutputTokens: 2000, maxTotalTokens: 1000 },
    { provider: 'ladder', policyId: 'sandbox-test-v1', maxInputTokens: 12000, maxOutputTokens: 2000, maxTotalTokens: 20000, approved: true },
  ])('rejects malformed or caller-extended host budget configuration', enforcement => {
    expect(() => runSpecPolicyOf({ RUN_SPEC_BUDGET_POLICIES: JSON.stringify({ 'profile-1': enforcement }) })).toThrow(RunSpecMappingError);
  });

  it('uses explicit host repository, input refs and runtime limits with no project inference', () => {
    const hostPolicy = runSpecPolicyOf({
      RUN_SPEC_REPOSITORY: JSON.stringify({ fullName: 'trained-assist/ai-agent-runner' }),
      RUN_SPEC_INPUT_REFS: JSON.stringify([{ ref: 'artifact://host-input.md', version: 'v1' }]),
      RUN_SPEC_TIMEOUT_MS: '240000',
      RUN_SPEC_ENV_ALLOWLIST: 'LANG',
    });
    const body = toSubmitRequest(buildRunSpec({ ...baseInput, engineName: 'dynamic-ip-azure-agent-run', refs: [{ ref: 'artifact://user-input.md' }] }, hostPolicy).spec);
    expect(body.repository).toEqual({ fullName: 'trained-assist/ai-agent-runner' });
    expect(body.input?.refs).toEqual([{ ref: 'artifact://host-input.md', version: 'v1' }, { ref: 'artifact://user-input.md' }]);
    expect(body.limits.timeoutMs).toBe(240_000);
    expect(body.envAllowlist).toEqual(['LANG']);
    expect(toSubmitRequest(buildRunSpec(baseInput, policy).spec).repository).toBeUndefined();
    expect(() => buildRunSpec(baseInput, runSpecPolicyOf({ RUN_SPEC_INPUT_REFS: '{}' }))).toThrow(RunSpecMappingError);
    expect(() => runSpecPolicyOf({ RUN_SPEC_TIMEOUT_MS: '0' })).toThrow(RunSpecMappingError);
    expect(() => runSpecPolicyOf({ RUN_SPEC_STARTUP_TIMEOUT_MS: '-1' })).toThrow(RunSpecMappingError);
    expect(() => runSpecPolicyOf({ RUN_SPEC_STARTUP_TIMEOUT_MS: '3600001' })).toThrow(RunSpecMappingError);
    expect(runSpecPolicyOf({ RUN_SPEC_STARTUP_TIMEOUT_MS: '600000' }).startupTimeoutMs).toBe(600_000);
  });

  it('projects explicit host output and log byte limits without changing legacy defaults', () => {
    const hostPolicy = runSpecPolicyOf({ RUN_SPEC_MAX_OUTPUT_BYTES: '1048576', RUN_SPEC_MAX_LOG_BYTES: '1048576' });
    const body = toSubmitRequest(buildRunSpec(baseInput, hostPolicy).spec);
    expect(body.limits.maxOutputBytes).toBe(1_048_576);
    expect(body.limits.maxLogBytes).toBe(1_048_576);
    expect(toSubmitRequest(buildRunSpec(baseInput, policy).spec).limits.maxLogBytes).toBeUndefined();
    for (const invalid of ['0', '-1', '1.5', 'invalid', '9007199254740992']) {
      expect(() => runSpecPolicyOf({ RUN_SPEC_MAX_LOG_BYTES: invalid })).toThrow(RunSpecMappingError);
    }
  });

  it('only the explicitly selected integration host profile supplies a repository default', () => {
    expect(runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'integration-v1' }).repository).toEqual({ fullName: 'trained-assist/ai-agent-runner' });
    expect(runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'integration-v1' }).timeoutMs).toBe(300_000);
    expect(runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'integration-v1' }).startupTimeoutMs).toBe(600_000);
    expect(buildRunSpec(baseInput, runSpecPolicyOf({})).spec.limits.timeoutMs).toBe(baseInput.timeoutMs);
    expect(runSpecPolicyOf({ ROUTER_SELECTOR: 'communication_v1' }).repository).toBeNull();
    expect(runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'integration-v1', RUN_SPEC_REPOSITORY: JSON.stringify({ fullName: 'explicit/override' }) }).repository).toEqual({ fullName: 'explicit/override' });
    expect(() => runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'invented' })).toThrow(RunSpecMappingError);
  });

  it('относительный путь выхода и небезопасный repository отклоняются локально', () => {
    const abs = runSpecPolicyOf({ RUN_SPEC_OUTPUTS: JSON.stringify([{ path: '/etc/passwd' }]) });
    expect(() => buildRunSpec(baseInput, abs)).toThrow(RunSpecMappingError);

    const traversal = runSpecPolicyOf({ RUN_SPEC_OUTPUTS: JSON.stringify([{ path: '../escape.md' }]) });
    expect(() => buildRunSpec(baseInput, traversal)).toThrow(RunSpecMappingError);

    const repo = runSpecPolicyOf({ RUN_SPEC_REPOSITORY: JSON.stringify({ fullName: 'not a repo' }) });
    expect(() => buildRunSpec(baseInput, repo)).toThrow(RunSpecMappingError);
  });

  it('MCP-сервер без инструментов и с дубликатом имени инструмента отклоняются', () => {
    const noTools = runSpecPolicyOf({
      RUN_SPEC_MCP: JSON.stringify({ servers: [{ serverId: 'fs', transport: 'stdio', command: 'node', allowedTools: [] }] }),
    });
    expect(() => buildRunSpec(baseInput, noTools)).toThrow(RunSpecMappingError);

    const dupTool = runSpecPolicyOf({
      RUN_SPEC_MCP: JSON.stringify({
        servers: [
          { serverId: 'a', transport: 'stdio', command: 'node', allowedTools: ['read_file'] },
          { serverId: 'b', transport: 'stdio', command: 'node', allowedTools: ['read_file'] },
        ],
      }),
    });
    expect(() => buildRunSpec(baseInput, dupTool)).toThrow(RunSpecMappingError);
  });

  it('токен репозитория не попадает в собранный RunSpec без явной политики', () => {
    const built = buildRunSpec(baseInput, policy);
    expect(built.spec.repository).toBeUndefined();
  });
});

describe('run-spec: проекция на тело POST /v1/runs', () => {
  it('контракт submit принимает только свои ключи — полный RunSpec не уходит', () => {
    const built = buildRunSpec(
      { ...baseInput, refs: [{ ref: 'artifact://a.md' }] },
      runSpecPolicyOf({
        RUN_SPEC_OUTPUTS: JSON.stringify([{ path: 'report.md', mime: 'text/markdown' }]),
        RUN_SPEC_REPOSITORY: JSON.stringify({ fullName: 'owner/name' }),
      }),
    );

    const body = toSubmitRequest(built.spec);
    expect(Object.keys(body).sort()).toEqual(
      ['conversationId', 'engine', 'envAllowlist', 'input', 'limits', 'outputs', 'repository', 'traceId', 'userTaskId'].sort(),
    );
    expect(body['userTaskId']).toBe('ut-abc123');
    expect('profileId' in body).toBe(false);
    expect('ownerGeneration' in body).toBe(false);
    expect('cwd' in body).toBe(false);
    expect('runId' in body).toBe(false);
    expect('mcp' in body).toBe(false);
    expect(body['input']).toEqual({ inlinePrompt: 'собери отчёт', refs: [{ ref: 'artifact://a.md' }] });
  });

  it('snapshotId не теряется на границе с Runner: уезжает в submit', () => {
    const built = buildRunSpec(
      { ...baseInput, refs: [{ ref: 'snap-df1c902a', snapshotId: 'snap-df1c902a' }] },
      policy,
    );
    const body = toSubmitRequest(built.spec);
    expect(body['input']).toEqual({ inlinePrompt: 'собери отчёт', refs: [{ ref: 'snap-df1c902a', snapshotId: 'snap-df1c902a' }] });
  });

  it('передаёт только immutable ingress pin в POST /v1/runs', () => {
    const built = buildRunSpec(baseInput, policy);
    built.spec.ingressManifest = {
      contractVersion: 1,
      manifestRef: 'cp-input-manifest:ut-abc123',
      manifestVersion: 'a'.repeat(64),
      userTaskId: built.spec.userTaskId,
      profileId: built.spec.profileId,
      runId: built.spec.runId,
      ownerGeneration: built.spec.ownerGeneration,
    };
    expect(toSubmitRequest(built.spec).ingressManifest).toEqual({
      contractVersion: 1,
      manifestRef: 'cp-input-manifest:ut-abc123',
      manifestVersion: 'a'.repeat(64),
    });
  });

  it('поля, которые Runner выводит сам, перечислены явно', () => {
    const built = buildRunSpec(baseInput, defaultRunSpecPolicy());
    // Без объявленного MCP его в списке нет — поле честно отсутствует.
    expect(untransmittedRunSpecFields(built.spec)).toEqual(
      ['contractVersion', 'jobId', 'runId', 'operationId', 'profileId', 'ownerGeneration', 'cwd'],
    );
  });

  it('MCP переносится в submit, а не выбрасывается: факт виден и в теле, и в списке непереданных', () => {
    const built = buildRunSpec(
      baseInput,
      runSpecPolicyOf({
        RUN_SPEC_MCP: JSON.stringify({ servers: [{ serverId: 'fs', transport: 'stdio', command: 'node', allowedTools: ['read_file'] }] }),
      }),
    );
    expect(built.spec.mcp?.servers).toHaveLength(1);
    expect(toSubmitRequest(built.spec).mcp).toEqual(built.spec.mcp);
    expect(untransmittedRunSpecFields(built.spec)).not.toContain('mcp');
  });

  it('удаляет host-only MCP scope и registry digest из закрытого Agent API request', () => {
    const server = {
      serverId: 'registry-fixture',
      transport: 'remote',
      url: 'https://registry.example.com/mcp',
      bindingRef: 'registry-mcp-test-160-read',
      allowedTools: ['read_fixture'],
      catalogueVersion: 'catalogue-v1',
      policyVersion: 'policy-v1',
    };
    const built = buildRunSpec(baseInput, runSpecPolicyOf({ RUN_SPEC_MCP: JSON.stringify({ servers: [server] }) }));
    Object.assign(built.spec.mcp!.servers[0]!, {
      scope: 'registry:fixture-read',
      registryDigest: 'a'.repeat(64),
    });

    const body = toSubmitRequest(built.spec, { engineSelection: 'agent_api' });
    expect(body.mcp?.servers[0]).toEqual(server);
    expect(JSON.stringify(body)).not.toContain('registry:fixture-read');
    expect(JSON.stringify(body)).not.toContain('registryDigest');
  });
});

describe('run-spec: удалённый MCP (transport remote)', () => {
  const remotePolicy = (server: Record<string, unknown>) =>
    runSpecPolicyOf({ RUN_SPEC_MCP: JSON.stringify({ servers: [server] }) });

  const remoteServer = (overrides: Record<string, unknown> = {}) => ({
    serverId: 'google-documents',
    transport: 'remote',
    url: 'https://documents.example.com/mcp',
    bindingRef: 'google-documents-v1',
    allowedTools: ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet'],
    toolTimeoutMs: 60_000,
    ...overrides,
  });

  it('хостовая политика RUN_SPEC_MCP собирает remote-сервер и проходит локальную проверку контракта', () => {
    const built = buildRunSpec(baseInput, remotePolicy(remoteServer()));

    expect(built.version).toBe('run-spec-v5');
    expect(built.spec.mcp).toEqual({ servers: [remoteServer()] });
    expect(validateRunSpec(built.spec).ok).toBe(true);
    expect(built.spec.credentialBindings).toBeUndefined();
  });

  it('в submit уходит ровно объявленное: transport, url, bindingRef, allowedTools — и никаких секретов', () => {
    const built = buildRunSpec(baseInput, remotePolicy(remoteServer()));
    const body = toSubmitRequest(built.spec);

    expect(body.mcp).toEqual(built.spec.mcp);
    const wire = JSON.stringify(body.mcp).toLowerCase();
    for (const forbidden of ['headers', 'authorization', 'token', 'secret', 'password', 'envallowlist', 'command', 'args', 'runauth']) {
      expect(wire).not.toContain(forbidden);
    }
    expect(untransmittedRunSpecFields(built.spec)).not.toContain('mcp');
  });

  it('клиентский mcp во входе отклоняется: MCP — хостовая политика', () => {
    const injected = {
      ...baseInput,
      mcp: { servers: [{ serverId: 'x', transport: 'remote', url: 'https://a.example.com/mcp', allowedTools: ['t'] }] },
    } as unknown as RunSpecInput;
    expect(() => buildRunSpec(injected, policy)).toThrow(RunSpecMappingError);
  });

  it('смешанный список stdio + remote сохраняется целиком в RunSpec и в теле submit', () => {
    const mixed = runSpecPolicyOf({
      RUN_SPEC_MCP: JSON.stringify({
        servers: [
          { serverId: 'fs', transport: 'stdio', command: 'node', args: ['server.mjs'], envAllowlist: ['HOME'], allowedTools: ['read_file'] },
          { serverId: 'jira', transport: 'remote', url: 'https://mcp.example.com/jira', bindingRef: 'mcp-jira', allowedTools: ['create_issue'] },
        ],
      }),
    });
    const built = buildRunSpec(baseInput, mixed);

    expect(built.spec.mcp?.servers.map((s) => s.serverId)).toEqual(['fs', 'jira']);
    expect(toSubmitRequest(built.spec).mcp?.servers.map((s) => s.transport)).toEqual(['stdio', 'remote']);
    expect(validateRunSpec(built.spec).ok).toBe(true);
  });

  it('URL с учётными данными, query, fragment, управляющими символами или не-absolute отклоняется', () => {
    for (const url of [
      'https://user:pass@mcp.example.com/jira',
      'https://mcp.example.com/jira?token=abc',
      'https://mcp.example.com/jira#frag',
      '/mcp',
      'mcp.example.com/jira',
      'ftp://mcp.example.com',
      'http://mcp.example.com/mcp',
      `https://mcp.example.com/${'a'.repeat(2000)}`,
      'https://mcp.example.com/ja\x00ra',
    ]) {
      expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ url })))).toThrow(RunSpecMappingError);
    }
  });

  it('заголовки/токены/секреты и stdio-поля в remote-сервере отклоняются как неизвестные', () => {
    for (const extra of [
      { headers: { authorization: 'Bearer x' } },
      { auth: 'Bearer x' },
      { token: 'x' },
      { secrets: ['x'] },
      { runAuth: { scope: 'jira' } },
      { command: 'node' },
      { args: ['server.mjs'] },
      { envAllowlist: ['TOKEN'] },
      { readinessTimeoutMs: 20_000 },
    ]) {
      expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer(extra)))).toThrow(RunSpecMappingError);
    }
  });

  it('неизвестный transport и небезопасный bindingRef отклоняются', () => {
    expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ transport: 'http' })))).toThrow(RunSpecMappingError);
    for (const bindingRef of [undefined, '', '   ', 'ref\x00x', 'r'.repeat(301)]) {
      expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ bindingRef })))).toThrow(RunSpecMappingError);
    }
  });

  it('tool timeout follows the bounded Runner contract', () => {
    for (const toolTimeoutMs of [0, -1, 1.5, 120_001]) {
      expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ toolTimeoutMs })))).toThrow(RunSpecMappingError);
    }
    expect(buildRunSpec(baseInput, remotePolicy(remoteServer({ toolTimeoutMs: 120_000 }))).spec.mcp).toBeDefined();
  });

  it('повторяющийся serverId и общий инструмент у stdio и remote отклоняются', () => {
    const dupServer = runSpecPolicyOf({
      RUN_SPEC_MCP: JSON.stringify({
        servers: [
          { serverId: 'jira', transport: 'remote', url: 'https://a.example.com/mcp', bindingRef: 'mcp-jira', allowedTools: ['search'] },
          { serverId: 'jira', transport: 'remote', url: 'https://b.example.com/mcp', bindingRef: 'mcp-other', allowedTools: ['other'] },
        ],
      }),
    });
    expect(() => buildRunSpec(baseInput, dupServer)).toThrow(/duplicate server id/);

    const crossTransportTool = runSpecPolicyOf({
      RUN_SPEC_MCP: JSON.stringify({
        servers: [
          { serverId: 'fs', transport: 'stdio', command: 'node', allowedTools: ['search'] },
          { serverId: 'jira', transport: 'remote', url: 'https://a.example.com/mcp', bindingRef: 'mcp-jira', allowedTools: ['search'] },
        ],
      }),
    });
    expect(() => buildRunSpec(baseInput, crossTransportTool)).toThrow(/already declared/);
  });

  it('rejects extra MCP envelope fields instead of serializing hidden auth metadata', () => {
    const hostPolicy = runSpecPolicyOf({ RUN_SPEC_MCP: JSON.stringify({ servers: [remoteServer()], headers: { authorization: 'fixture-only' } }) });
    expect(() => buildRunSpec(baseInput, hostPolicy)).toThrow(/unsupported field for remote metadata/);
  });

  it('allows only a bounded explicit tool declaration without treating it as enforcement', () => {
    expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ allowedTools: [] })))).toThrow(/at least one tool/);
    expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ allowedTools: ['read', 'read'] })))).toThrow(/already declared/);
    expect(() => buildRunSpec(baseInput, remotePolicy(remoteServer({ allowedTools: Array.from({ length: 51 }, (_, index) => `tool_${index}`) })))).toThrow(/at most 50/);
    const built = buildRunSpec(baseInput, remotePolicy(remoteServer({ toolTimeoutMs: undefined })));
    expect(toSubmitRequest(built.spec).mcp?.servers[0]).toEqual(remoteServer({ toolTimeoutMs: undefined }));
  });

  it('Agent API selection omits engine so the API chooses from its configured chain', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ requestId: 'req-1', userTaskId: 'ut-abc123', runId: 'run-1', deduplicated: false }), {
        status: 202, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const adapter = new RunnerApiAdapter('http://runner.local', 'test-key', fetchImpl, 'agent_api');
    const built = buildRunSpec(baseInput, remotePolicy(remoteServer()));

    await adapter.submit({ userTaskId: 'ut-abc123', idempotencyKey: 'k1', runSpec: built.spec });

    expect(bodies[0]).not.toHaveProperty('engine');
    expect(bodies[0]).toMatchObject({ userTaskId: 'ut-abc123', limits: { timeoutMs: 120_000 } });
  });

  it('adapter.submit с runSpec отправляет ровно проекцию: mcp в теле, служебные поля и секреты — нет', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ requestId: 'req-1', userTaskId: 'ut-abc123', runId: 'run-1', deduplicated: false }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const adapter = new RunnerApiAdapter('http://runner.local', 'test-key', fetchImpl);

    const built = buildRunSpec(baseInput, remotePolicy(remoteServer()));
    const receipt = await adapter.submit({ userTaskId: 'ut-abc123', idempotencyKey: 'k1', runSpec: built.spec });

    expect(receipt.runId).toBe('run-1');
    expect(bodies[0]!['mcp']).toEqual(toSubmitRequest(built.spec).mcp);
    expect(bodies[0]!['contractVersion']).toBeUndefined();
    expect(bodies[0]!['cwd']).toBeUndefined();
    expect(JSON.stringify(bodies[0])).not.toContain('Bearer');
  });
});

describe('run-spec: собранный RunSpec проходит локальную проверку контракта', () => {
  it('каждый портитый вариант ловится до отправки в Runner', () => {
    const built = buildRunSpec(baseInput, policy);
    const mutate = (fn: (spec: RunSpec) => void) => {
      const spec: RunSpec = JSON.parse(JSON.stringify(built.spec));
      fn(spec);
      return validateRunSpec(spec);
    };

    expect(mutate((s) => { s.cwd = '../../etc'; }).ok).toBe(false);
    expect(mutate((s) => { s.envAllowlist = ['A=1']; }).ok).toBe(false);
    expect(mutate((s) => { s.outputs = [{ path: '/abs' }]; }).ok).toBe(false);
    expect(mutate((s) => { s.input = { inlinePrompt: 'a\x00b' }; }).ok).toBe(false);
    expect(mutate((s) => { s.engine = { name: '', adapterVersion: '1' }; }).ok).toBe(false);
    expect(mutate((s) => { s.limits = { timeoutMs: 0 }; }).ok).toBe(false);
    expect(mutate((s) => { s.repository = { fullName: 'x' }; }).ok).toBe(false);
    expect(mutate((s) => { s.mcp = { servers: [{ serverId: 's', transport: 'stdio', command: 'c', allowedTools: [] }] }; }).ok).toBe(false);
  });
});
