/** Resolve an explicit task engine against the host's trusted configured default. */
export function runnerEngineOf(requested: unknown, configured?: string): string | undefined {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  const fallback = configured?.trim();
  return fallback || undefined;
}

/** The Agent API owns placement; CP records an API mode instead of a worker name. */
export function runnerDispatchModeOf(selection: string | undefined, requested: unknown, configured?: string): string | undefined {
  if (selection === 'agent_api') return 'agent_api';
  return runnerEngineOf(requested, configured);
}
