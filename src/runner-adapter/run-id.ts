/** Accept both legacy UUID receipts and the sharded Durable Object Worker format. */
export function isRunnerRunId(value: unknown): value is string {
  return typeof value === 'string' && (
    /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    || /^run_[a-f0-9]{64}_[a-f0-9]{24}$/.test(value)
  );
}
