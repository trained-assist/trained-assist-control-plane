import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const agentDir = new URL('../contracts/agent-profile-context-v1/', import.meta.url);
const readJson = async (base, path) => JSON.parse(await readFile(new URL(path, base), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await readJson(agentDir, 'source.json');
const producerRevision = '3cc6358b052a466410c3b45e3355ec3f7548dd30';
assert.equal(source.repository, 'trained-assist/trained-assist-agent');
assert.equal(source.revision, producerRevision);

const pinned = {};
for (const [name, digest] of Object.entries(source.artifacts)) {
  const bytes = await readFile(new URL(name, agentDir));
  assert.equal(sha256(bytes), digest, `${name} SHA mismatch`);
  pinned[name] = JSON.parse(bytes.toString('utf8'));
}

const contract = pinned['contract.json'];
const schema = pinned['profile-context.schema.json'];
assert.equal(contract.urn, 'urn:trained-assist:agent-profile-context:v1');
assert.equal(contract.owner, 'trained-assist-agent');
assert.equal(contract.status, 'contract_only');
assert.equal(contract.authority.profileInputFromBrowserAllowed, false);
assert.equal(contract.authority.legacyPerProfileJwtAllowed, false);
assert.equal(contract.authority.browserReadableSelectionCookieAllowed, false);
assert.deepEqual(schema.required, ['principalId', 'profileId', 'sessionId', 'profileGeneration']);
assert.equal(schema.additionalProperties, false);

const cpIdentity = await readJson(new URL('../contracts/', import.meta.url), 'connected-app-identity-v1.contract.json');
assert.deepEqual(cpIdentity.agentProfileAuthority, {
  urn: contract.urn,
  version: contract.version,
  owner: contract.owner,
  sourceRevision: producerRevision,
  sourcePath: source.contractPath,
  contextSchemaPath: 'contracts/agent-profile-context-v1/profile-context.schema.json',
  contextFields: schema.required,
  runtimeStatus: 'opt_in_agent_authority_candidate',
});

const cpModule = await readFile(new URL('../src/agent-profile-authority/contract.ts', import.meta.url), 'utf8');
const contextType = cpModule.match(/export type AgentProfileContext = \{([^}]+)\}/s)?.[1];
assert.ok(contextType, 'Agent profile authority must expose the typed AgentProfileContext port');
const contextFields = [...contextType.matchAll(/\b(\w+)\s*:/g)].map(match => match[1]);
assert.deepEqual(contextFields, schema.required);
assert.match(cpModule, /resolveBrowserSession\(request: Request\): Promise<AgentProfileContext \| null>/);
assert.match(cpModule, /resolveCurrentSession\(sessionId: string\): Promise<AgentProfileContext \| null>/);
console.log('Agent Profile Context v1 is SHA-pinned and matches the CP authority port.');
