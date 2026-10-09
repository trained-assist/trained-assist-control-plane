import { describe, expect, it } from 'vitest';
import { isRunnerRunId } from '../src/runner-adapter/run-id';

describe('Runner run id formats', () => {
  it('accepts both the legacy UUID and Cloudflare Worker sharded receipts', () => {
    expect(isRunnerRunId('run_40085128-f369-4dea-a3e2-123456789012')).toBe(true);
    expect(isRunnerRunId(`run_${'a'.repeat(64)}_${'b'.repeat(24)}`)).toBe(true);
  });

  it('rejects malformed and unprefixed ids', () => {
    expect(isRunnerRunId('foreign')).toBe(false);
    expect(isRunnerRunId(`run_${'a'.repeat(63)}_${'b'.repeat(24)}`)).toBe(false);
  });
});
