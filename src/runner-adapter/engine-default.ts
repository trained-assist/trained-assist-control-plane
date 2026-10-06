/** Resolve an explicit task engine against the host's trusted configured default. */
export function runnerEngineOf(requested: unknown, configured?: string): string | undefined {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  const fallback = configured?.trim();
  return fallback || undefined;
}
