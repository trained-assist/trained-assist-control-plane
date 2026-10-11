import { describe, expect, it } from 'vitest';
import { runnerDispatchModeOf, runnerEngineOf } from '../src/runner-adapter/engine-default';

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

  it('leaves engine and worker placement to Runner API in agent_api mode', () => {
    expect(runnerDispatchModeOf('agent_api', 'dynamic-ip-azure-agent-run', 'eu-vm-agent-run')).toBe('agent_api');
  });

  it('keeps caller-selected engines only in the caller-owned mode', () => {
    expect(runnerDispatchModeOf('caller', 'custom-engine', 'eu-vm-agent-run')).toBe('custom-engine');
    expect(runnerDispatchModeOf(undefined, undefined, 'eu-vm-agent-run')).toBe('eu-vm-agent-run');
  });
});
