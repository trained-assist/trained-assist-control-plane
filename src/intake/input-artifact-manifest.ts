import type { TaskRow } from '../taskstore';

export interface InputArtifactManifestV1 {
  contractVersion: 1;
  ref: string;
  version: string;
  ownerProfileId: string;
  mediaType: string;
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface InputManifestItemV1 {
  text?: string;
  artifacts: InputArtifactManifestV1[];
}

export interface InputManifestV1 {
  manifestRef: string;
  manifestVersion: string;
  contractVersion: 1;
  userTaskId: string;
  profileId: string;
  inputItems: InputManifestItemV1[];
}

export async function inputManifestForTask(task: Pick<TaskRow, 'id' | 'profile_id' | 'user_value'>): Promise<InputManifestV1 | null> {
  let userValue: Record<string, unknown>;
  try {
    userValue = JSON.parse(task.user_value ?? '{}') as Record<string, unknown>;
  } catch {
    throw new Error('task input manifest is invalid');
  }
  if (!Array.isArray(userValue.inputArtifacts) || userValue.inputArtifacts.length === 0
    || !userValue.inputArtifacts.some((artifact) => artifact && typeof artifact === 'object'
      && (artifact as Record<string, unknown>).contractVersion === 1)) return null;
  if (!Array.isArray(userValue.inputItems)) throw new Error('task input manifest is invalid');

  const inputItems = userValue.inputItems.map((rawItem) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error('task input manifest is invalid');
    const item = rawItem as Record<string, unknown>;
    if (item.text !== undefined && item.text !== null && typeof item.text !== 'string') throw new Error('task input manifest is invalid');
    const rawArtifacts = Array.isArray(item.artifacts) ? item.artifacts : [];
    const artifacts = rawArtifacts.map((rawArtifact) => {
      if (!rawArtifact || typeof rawArtifact !== 'object' || Array.isArray(rawArtifact)) throw new Error('task input manifest is invalid');
      const artifact = rawArtifact as Record<string, unknown>;
      if (artifact.contractVersion !== 1
        || typeof artifact.ref !== 'string'
        || typeof artifact.version !== 'string'
        || artifact.ownerProfileId !== task.profile_id
        || typeof artifact.mediaType !== 'string'
        || typeof artifact.name !== 'string'
        || !Number.isSafeInteger(artifact.sizeBytes)
        || typeof artifact.sha256 !== 'string') throw new Error('task input manifest is invalid');
      return {
        contractVersion: 1 as const,
        ref: artifact.ref,
        version: artifact.version,
        ownerProfileId: artifact.ownerProfileId,
        mediaType: artifact.mediaType,
        name: artifact.name,
        sizeBytes: artifact.sizeBytes as number,
        sha256: artifact.sha256,
      };
    });
    return { ...(typeof item.text === 'string' ? { text: item.text } : {}), artifacts };
  });
  const inputArtifacts = inputItems.flatMap((item) => item.artifacts);
  if (inputArtifacts.length === 0) throw new Error('task input manifest is invalid');
  const canonical = JSON.stringify({ contractVersion: 1, userTaskId: task.id, profileId: task.profile_id, inputItems });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const version = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    manifestRef: `cp-input-manifest:${task.id}`,
    manifestVersion: version,
    contractVersion: 1,
    userTaskId: task.id,
    profileId: task.profile_id,
    inputItems,
  };
}
