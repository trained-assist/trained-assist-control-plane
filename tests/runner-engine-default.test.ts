import { describe, expect, it } from 'vitest';
import { runnerEngineOf } from '../src/runner-adapter/engine-default';

describe('runner engine default', () => {
  it('uses the host configured engine when a gateway starts a task without choosing one', () => {
    expect(runnerEngineOf(undefined, 'dynamic-ip-azure-agent-run')).toBe('dynamic-ip-azure-agent-run');
  });

  it('keeps an explicit non-empty engine and trims whitespace', () => {
    expect(runnerEngineOf(' custom-engine ', 'dynamic-ip-azure-agent-run')).toBe('custom-engine');
  });

  it('leaves the existing default behavior when neither value is configured', () => {
    expect(runnerEngineOf(undefined, '  ')).toBeUndefined();
    expect(runnerEngineOf('', undefined)).toBeUndefined();
  });
});
