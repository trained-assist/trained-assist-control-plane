import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dir = new URL('../contracts/connected-app-approval-receipt-v1/', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, dir), 'utf8'));
const contract = await json('contract.json');
assert.equal(contract.contract, 'trained-assist.connected-app-approval-receipt');
assert.equal(contract.version, 1);
assert.equal(contract.owner, 'trained-assist-control-plane');
assert.equal(contract.basePath, '/v1/connected-app-approvals');
assert.deepEqual(contract.clients['crm-web'].commands['crm.deals.create'], {
  audience: 'crm-web', requiredScope: 'crm.deals.create',
});
assert.deepEqual(contract.limits, {
  intentTtlSeconds: 600, receiptRetentionSeconds: 7776000, maxOperationBytes: 16384,
});
assert.equal(contract.semantics.getReviewApproves, false);
assert.equal(contract.semantics.consumeIsSingleUse, true);
assert.equal(contract.semantics.sameConsumerRequestIdRecoversOriginalReceipt, true);
assert.equal(contract.semantics.externalProviderExactlyOnce, false);

const prepareRequest = await json('prepare-request.schema.json');
const prepareResponse = await json('prepare-response.schema.json');
const consumeRequest = await json('consume-request.schema.json');
const consumeResponse = await json('consume-response.schema.json');
assert.equal(prepareRequest.additionalProperties, false);
assert.deepEqual(prepareRequest.required, ['appToken', 'audience', 'command', 'sourceRevision', 'operation']);
assert.deepEqual(Object.keys(prepareRequest.properties), prepareRequest.required);
assert.equal(prepareResponse.additionalProperties, false);
assert.deepEqual(Object.keys(prepareResponse.properties), prepareResponse.required);
assert.equal(consumeRequest.additionalProperties, false);
assert.deepEqual(consumeRequest.required, ['appToken', 'audience', 'command', 'sourceRevision', 'operation', 'intentId', 'consumerRequestId']);
assert.deepEqual(Object.keys(consumeRequest.properties), consumeRequest.required);
assert.equal(consumeResponse.additionalProperties, false);
assert.deepEqual(Object.keys(consumeResponse.properties), consumeResponse.required);
assert.equal(consumeResponse.properties.receipt.additionalProperties, false);
assert.deepEqual(Object.keys(consumeResponse.properties.receipt.properties), consumeResponse.properties.receipt.required);
console.log('Connected App approval receipt v1 contract artifacts are internally consistent.');
