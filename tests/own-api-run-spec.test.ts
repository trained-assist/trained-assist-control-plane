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

  it('пустой prompt отклоняется: задача без сообщения — не задача', () => {
    expect(() => buildRunSpec({ ...baseInput, prompt: '   ' }, policy)).toThrow(RunSpecMappingError);
  });

  it('многострочный prompt нормализуется (контракт Runner\'а не пропускает control chars)', () => {
    const built = buildRunSpec({ ...baseInput, prompt: 'первая\nвторая\tтретья' }, policy);
    expect(built.promptNormalized).toBe(true);
    expect(built.spec.input?.inlinePrompt).toBe('первая вторая третья');
    expect(validateRunSpec(built.spec).ok).toBe(true);
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
    expect(mutate((s) => { s.input = { inlinePrompt: 'a\nb' }; }).ok).toBe(false);
    expect(mutate((s) => { s.engine = { name: '', adapterVersion: '1' }; }).ok).toBe(false);
    expect(mutate((s) => { s.limits = { timeoutMs: 0 }; }).ok).toBe(false);
    expect(mutate((s) => { s.repository = { fullName: 'x' }; }).ok).toBe(false);
    expect(mutate((s) => { s.mcp = { servers: [{ serverId: 's', transport: 'stdio', command: 'c', allowedTools: [] }] }; }).ok).toBe(false);
  });
});
