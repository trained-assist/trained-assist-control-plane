import type { InputArtifactManifest } from './envelope';

export class IngressArtifactUnavailableError extends Error {
  constructor() {
    super('ingress artifact verification is unavailable');
    this.name = 'IngressArtifactUnavailableError';
  }
}

export class IngressArtifactRejectedError extends Error {
  constructor() {
    super('ingress artifact manifest was not verified');
    this.name = 'IngressArtifactRejectedError';
  }
}

export interface IngressArtifactVerifier {
  verify(profileId: string, manifest: InputArtifactManifest): Promise<void>;
}

export function ingressArtifactVerifierOf(binding?: Fetcher): IngressArtifactVerifier | undefined {
  if (!binding) return undefined;
  return {
    async verify(profileId, manifest) {
      let response: Response;
      try {
        response = await binding.fetch('https://ingress-buffer/v1/manifests/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profileId, manifest }),
        });
      } catch {
        throw new IngressArtifactUnavailableError();
      }
      if (response.status === 404 || response.status >= 500) throw new IngressArtifactUnavailableError();
      if (!response.ok) throw new IngressArtifactRejectedError();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new IngressArtifactRejectedError();
      }
      if (!payload || typeof payload !== 'object' || (payload as Record<string, unknown>).verified !== true) {
        throw new IngressArtifactRejectedError();
      }
      const verified = (payload as Record<string, unknown>).manifest;
      if (!verified || typeof verified !== 'object') throw new IngressArtifactRejectedError();
      const value = verified as Record<string, unknown>;
      const exact = value.contractVersion === manifest.contractVersion
        && value.ref === manifest.ref
        && value.version === manifest.version
        && value.ownerProfileId === manifest.ownerProfileId
        && value.mediaType === manifest.mediaType
        && value.name === manifest.name
        && value.sizeBytes === manifest.sizeBytes
        && value.sha256 === manifest.sha256;
      if (!exact || manifest.ownerProfileId !== profileId) throw new IngressArtifactRejectedError();
    },
  };
}
