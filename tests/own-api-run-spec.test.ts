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
  type RunSpecPolicy,
} from '../src/run-spec/run-spec';
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
    expect(toSubmitRequest(built.spec).input?.inlinePrompt).toBe(`${prompt}\n\nAdditional instructions:\n${instructions}`);
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
  });

  it('only the explicitly selected integration host profile supplies a repository default', () => {
    expect(runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'integration-v1' }).repository).toEqual({ fullName: 'trained-assist/ai-agent-runner' });
    expect(runSpecPolicyOf({ RUN_SPEC_POLICY_PROFILE: 'integration-v1' }).timeoutMs).toBe(300_000);
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

  it('поля, которые Runner выводит сам, перечислены явно', () => {
    const built = buildRunSpec(baseInput, defaultRunSpecPolicy());
    // Без объявленного MCP его в списке нет — поле честно отсутствует.
    expect(untransmittedRunSpecFields(built.spec)).toEqual(
      ['contractVersion', 'jobId', 'runId', 'operationId', 'profileId', 'ownerGeneration', 'cwd'],
    );
  });

  it('MCP объявляется в mapping, но в submit не переносится — факт виден', () => {
    const built = buildRunSpec(
      baseInput,
      runSpecPolicyOf({
        RUN_SPEC_MCP: JSON.stringify({ servers: [{ serverId: 'fs', transport: 'stdio', command: 'node', allowedTools: ['read_file'] }] }),
      }),
    );
    expect(built.spec.mcp?.servers).toHaveLength(1);
    expect('mcp' in toSubmitRequest(built.spec)).toBe(false);
    expect(untransmittedRunSpecFields(built.spec)).toContain('mcp');
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
