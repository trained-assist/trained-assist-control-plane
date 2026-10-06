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
Authorization: Bearer <INGRESS_BUFFER_TOKEN>
```

```json
{"profileId":"profile-1","manifest":{"contractVersion":1,"ref":"opaque-buffer-ref","version":"immutable-object-version","ownerProfileId":"profile-1","mediaType":"audio/ogg","name":"voice.ogg","sizeBytes":12345,"sha256":"<digest>"}}
```

The buffer returns HTTP 200 only after confirming object existence, immutable version, profile ownership, size, MIME, and SHA-256:

```json
{"verified":true,"manifest":{"contractVersion":1,"ref":"opaque-buffer-ref","version":"immutable-object-version","ownerProfileId":"profile-1","mediaType":"audio/ogg","name":"voice.ogg","sizeBytes":12345,"sha256":"<digest>"}}
```

The buffer accepts only the shared `INGRESS_BUFFER_TOKEN`, configured as a secret independently on the buffer Worker, CP sandbox, and Telegram sandbox. CP sends this credential over the private service binding for verification and content reads; it is never included in an intake envelope, RunSpec, or logs. Missing binding, missing token, unavailable buffer, missing object, or mismatched metadata prevents task admission; there is no text-only partial fallback. The verifier is an admission check, not the Runner byte transport. Runner materialization remains a separate required integration before media execution can be enabled.

## Runner read API

Runner uses the same signed principal authentication as other CP clients. Its principal needs `tasks:read` for the task profile. Credentials stay in Runner deployment bindings and are never put in RunSpec. The CP exposes a task-pinned manifest:

```http
GET /runner/input-manifest?taskId=<userTaskId>
```

Response fields are `manifestRef`, content-addressed `manifestVersion`, `contractVersion`, `userTaskId`, `profileId`, and ordered `inputItems[]` (each with optional text and verified artifact metadata). The hash covers the task/profile identity and the full ordered input snapshot.

For bytes, Runner requests a ref only from that pinned manifest:

```http
GET /runner/input-artifact?taskId=<userTaskId>&manifestRef=<manifestRef>&manifestVersion=<sha256>&ref=<opaque-ref>&version=<object-version>
```

The CP forwards `Authorization: Bearer <INGRESS_BUFFER_TOKEN>` on its private buffer content request.

CP checks signed `tasks:read` authorization, manifest identity/version, and artifact membership before reading through the private buffer binding. The buffer's `GET /v1/artifacts/content?profileId=…&ref=…&version=…` response must carry `x-artifact-ref`, `x-artifact-version`, `x-artifact-owner-profile-id`, `x-artifact-size-bytes`, `x-artifact-sha256`, `Content-Type`, and `Content-Length`; CP compares all headers against the admitted manifest and streams the body without buffering it. Runner independently verifies exact bytes and SHA-256 before exposing any input to the engine.
