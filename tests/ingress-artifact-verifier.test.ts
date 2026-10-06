import { describe, expect, it, vi } from 'vitest';
import { IngressArtifactRejectedError, IngressArtifactUnavailableError, ingressArtifactVerifierOf } from '../src/intake';
import type { InputArtifactManifest } from '../src/intake/envelope';

const manifest: InputArtifactManifest = {
  contractVersion: 1,
  ref: 'opaque-media-ref',
  version: 'v1',
  ownerProfileId: 'profile-a',
  mediaType: 'audio/ogg',
  name: 'clip.ogg',
  sizeBytes: 128,
  sha256: 'b'.repeat(64),
};

describe('ingress artifact verification boundary', () => {
  it('sends only profile scope and immutable manifest to the private buffer binding', async () => {
    const fetch = vi.fn(async () => Response.json({ verified: true, manifest: { ...manifest } }));
    const verifier = ingressArtifactVerifierOf({ fetch } as unknown as Fetcher);
    await verifier?.verify('profile-a', manifest);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ingress-buffer/v1/manifests/verify');
    expect(JSON.parse(String(init.body))).toEqual({ profileId: 'profile-a', manifest });
  });

  it('fails closed on unavailable binding and metadata mismatch', async () => {
    expect(ingressArtifactVerifierOf(undefined)).toBeUndefined();
    const mismatch = ingressArtifactVerifierOf({
      fetch: async () => Response.json({ verified: true, manifest: { ...manifest, sha256: 'c'.repeat(64) } }),
    } as unknown as Fetcher);
    await expect(mismatch?.verify('profile-a', manifest)).rejects.toBeInstanceOf(IngressArtifactRejectedError);
  });

  it('fails closed on buffer errors or unverified refs', async () => {
    for (const response of [new Response('unavailable', { status: 503 }), new Response('missing', { status: 404 })]) {
      const verifier = ingressArtifactVerifierOf({ fetch: async () => response.clone() } as unknown as Fetcher);
      await expect(verifier?.verify('profile-a', manifest)).rejects.toBeInstanceOf(IngressArtifactUnavailableError);
    }
    const rejected = ingressArtifactVerifierOf({ fetch: async () => Response.json({ verified: false }) } as unknown as Fetcher);
    await expect(rejected?.verify('profile-a', manifest)).rejects.toBeInstanceOf(IngressArtifactRejectedError);
  });
});
