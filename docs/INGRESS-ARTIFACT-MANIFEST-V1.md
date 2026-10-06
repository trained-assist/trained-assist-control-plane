# Ingress artifact manifest v1

This contract carries references to bytes already stored by the passive ingress buffer. It does not carry bytes, Telegram identifiers, signed URLs, or credentials into the Control Plane Task Store.

## Intake shape

An ordered `inputItems[]` entry may include `text` and `artifacts[]` together. Each artifact has this shape:

```json
{
  "contractVersion": 1,
  "ref": "opaque-buffer-ref",
  "version": "immutable-object-version",
  "ownerProfileId": "profile-1",
  "mediaType": "audio/ogg",
  "name": "voice.ogg",
  "sizeBytes": 12345,
  "sha256": "<64 lowercase hex characters>"
}
```

The gateway preserves item order and submits the complete snapshot only on the selected launch action. Limits are 16 artifacts and 40 MiB total per admission, with a 20 MiB maximum per artifact. Text-only envelopes remain unchanged.

## Buffer verification

Before writing a durable receipt, CP sends the profile scope and submitted manifest over its private `INGRESS_BUFFER` service binding:

```http
POST https://ingress-buffer/v1/manifests/verify
Content-Type: application/json
```

```json
{"profileId":"profile-1","manifest":{"contractVersion":1,"ref":"opaque-buffer-ref","version":"immutable-object-version","ownerProfileId":"profile-1","mediaType":"audio/ogg","name":"voice.ogg","sizeBytes":12345,"sha256":"<digest>"}}
```

The buffer returns HTTP 200 only after confirming object existence, immutable version, profile ownership, size, MIME, and SHA-256:

```json
{"verified":true,"manifest":{"contractVersion":1,"ref":"opaque-buffer-ref","version":"immutable-object-version","ownerProfileId":"profile-1","mediaType":"audio/ogg","name":"voice.ogg","sizeBytes":12345,"sha256":"<digest>"}}
```

CP requires an exact metadata match. Missing binding, unavailable buffer, missing object, or mismatched metadata prevents task admission; there is no text-only partial fallback. The verifier is an admission check, not the Runner byte transport. Runner materialization remains a separate required integration before media execution can be enabled.
