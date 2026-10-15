import type { RunSpec } from './run-spec';

/** A receipt-backed snapshot of host input, never engine system prompts or credentials. */
export interface AcceptedAgentInput {
  contractVersion: 1;
  taskId: string;
  runId: string;
  generation: number;
  input: RunSpec['input'] | null;
  instructions: string | null;
  ingressManifest: RunSpec['ingressManifest'] | null;
}

export function acceptedAgentInput(spec: RunSpec, runId: string, generation: number): AcceptedAgentInput {
  return { contractVersion: 1, taskId: spec.userTaskId, runId, generation,
    input: spec.input ?? null, instructions: spec.instructions ?? null,
    ingressManifest: spec.ingressManifest ?? null };
}

export async function agentInputArtifact(input: AcceptedAgentInput) {
  const body = new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { body, ref: `cp-agent-input:${input.runId}`, name: `agent-input-g${input.generation}-${input.runId}.json`,
    sizeBytes: body.byteLength, sha256, contentType: 'application/json' };
}
