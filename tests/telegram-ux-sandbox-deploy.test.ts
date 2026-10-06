import { describe, expect, it } from 'vitest';
import { TELEGRAM_UX_SANDBOX, telegramUxPrincipalSignature, validateTelegramUxSandboxConfig } from '../src/deployment/telegram-ux-sandbox';

const config = {
  name: TELEGRAM_UX_SANDBOX.workerName,
  workers_dev: true,
  d1_databases: [{ database_name: TELEGRAM_UX_SANDBOX.databaseName, database_id: TELEGRAM_UX_SANDBOX.databaseId }],
  workflows: [{ name: TELEGRAM_UX_SANDBOX.workflowName }],
  services: [
    { binding: 'COMMUNICATION_SERVICE', service: 'trained-assist-communication-v1-sandbox' },
    { binding: 'REGISTRY_MCP_HOST_SERVICE', service: 'trained-assist-mcp-host-test-160' },
    { binding: 'INGRESS_BUFFER', service: 'trained-assist-ingress-buffer-sandbox' },
  ],
};

describe('Telegram UX sandbox deploy guard', () => {
  it('accepts only the pinned sandbox Worker, D1 and Workflow', () => {
    expect(validateTelegramUxSandboxConfig(config)).toBe(true);
  });

  it('refuses a non-sandbox Worker target', () => {
    expect(() => validateTelegramUxSandboxConfig({ ...config, name: 'trained-assist-control-plane' }))
      .toThrow('sandbox_worker_mismatch');
  });

  it('refuses a different or shared D1 database', () => {
    const wrongDatabase = { ...config, d1_databases: [{ ...config.d1_databases[0], database_id: 'other' }] };
    expect(() => validateTelegramUxSandboxConfig(wrongDatabase)).toThrow('sandbox_database_mismatch');
  });

  it('refuses service bindings outside the reviewed sandbox', () => {
    const wrongService = { ...config, services: [{ binding: 'COMMUNICATION_SERVICE', service: 'production' }] };
    expect(() => validateTelegramUxSandboxConfig(wrongService)).toThrow('sandbox_service_binding_mismatch');
  });

  it('derives the same HMAC signature for the configured principal deterministically', async () => {
    expect(await telegramUxPrincipalSignature('sandbox-secret'))
      .toBe('40ee8b265a654c6867c1edd325ba0f05fc7bb624b34840cef15c8cbff1a5c1f7');
  });
});
