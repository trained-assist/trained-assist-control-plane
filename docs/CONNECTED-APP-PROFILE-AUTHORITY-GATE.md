# Connected App profile authority gate

Status: blocked for live browser issuance. This note follows the opt-in D1 issuer in PR #68. It does not change the version 1 contract or enable a route.

## Source audit

The platform contract [C14](https://github.com/trained-assist/trained-agent-architecture/blob/main/contracts/C14-CONNECTED-APPLICATION.md) requires a platform-authenticated user and a selected profile that the app cannot choose. The currently available stores do not yet provide that complete tuple:

| Source | What it proves | Missing for Connected Apps |
| --- | --- | --- |
| Control Plane `admission_principals` (`migrations/0002_task_admission.sql`, `src/intake/authorization.ts`) | An authenticated API caller may be bound to one `profile_id` and task scopes. It is used for task admission. | No browser session, selected-profile transition, user/profile membership or guarantee that the caller is an end-user rather than a gateway/service principal. It cannot be treated as the Connected App user authority. |
| Legacy Agent `src/web-auth.js` | A per-profile JWT can authenticate a legacy web request; `web_current` selects a per-profile cookie. | The selector is readable and writable by browser JS. The old JWT and cookie are explicitly excluded by identity v1. This state does not provide the new platform principal/session lifecycle. |
| `trained-assist-web/worker.mjs` `SessionHub` | Its Durable Object maps its own cookie to a `username` after legacy `/web/verify` or a signed journal ticket. | Authentication still delegates to the legacy agent password store. The stored username is not a verified new principal/profile binding; logout and profile changes are not invalidated in Control Plane. |
| Control Plane PR #68 `connected_app_sessions` | Stores host-supplied principal/profile/session and invalidates tokens on host updates. | The host credential authenticates the calling backend. It does not independently prove the user/profile tuple in the request. Setting the feature flag alone is insufficient for live end-user issuance. |

Do not import `admission_principals` as a user directory or copy a legacy username into `profileId`. A verified old-to-new principal/profile mapping and an authenticated selected-profile session source are prerequisites. This also blocks automatic CRM old `USER_ID` linkage.

## Required authority port

Control Plane must own the durable authenticated-user → selected-profile binding and its generation, either directly or through an explicitly versioned platform identity provider under its authority. The host must implement `resolveSelectedProfile(verifiedSession)` and return an immutable snapshot `{principalRef, profileRef, sessionRef, bindingGeneration, allowedAudiences, allowedScopes}`. The `verifiedSession` comes from host authentication, not from app JSON, query parameters, legacy `web_current`, a model tool payload or an Agent Run ID. The host must confirm membership and current selection against that durable profile lifecycle state. It must publish logout, principal disable, scope removal and profile switch to the issuer (or let the issuer query the same authority on every introspection). If that authority is unavailable, issue and introspection fail closed.

The PR #68 `select` endpoint is a backend integration seam only. Its `profileId` field remains untrusted until this authority port supplies the value and production host credentials are restricted to that server-side caller. No browser or connected app service may hold `CONNECTED_APP_HOST_KEY` or call `select`/`issue`.

## Authorization Code + PKCE S256 handoff to implement next

Use the first-party confidential BFF pattern from [RFC 10017 §6.1](https://www.rfc-editor.org/rfc/rfc10017.html#section-6.1) and the code-flow protections in [RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1). The initial Control Plane code slice uses standard `response_type=code`, `client_id`, exact `redirect_uri`, `scope`, `state`, `code_challenge_method=S256` and `code_verifier` fields. Until metadata, client registration and the host authority adapter are completed, it is a closed first-party profile of Authorization Code + PKCE, not a general OAuth/OIDC server.

1. The BFF creates a fresh high-entropy `state` and PKCE `code_verifier`, stores both in its server-side browser transaction, and sends `code_challenge=BASE64URL(SHA256(code_verifier))` to the platform authorization endpoint. The platform resolves the authenticated user's current profile through the authority port and records a random code **hash** bound to session, profile generation, confidential client/audience, exact registered redirect URI, CSRF state, S256 challenge and a short expiry (for example 60 seconds). The code is single use.
2. The browser is redirected to that exact registered app callback with code, state and issuer identifier. No bearer token, profile ID or old agent cookie is placed in the URL. The BFF checks stored state and issuer, then exchanges the code with its client credential and PKCE verifier. Wrong client, redirect, state, verifier, expired code and replay fail before any token is issued.
3. Control Plane atomically consumes the code, rechecks the current host profile generation and grants, then issues the opaque audience-bound token to the **BFF**. The BFF holds it server side behind an HttpOnly, Secure, SameSite session cookie; browser JavaScript never receives the token. The BFF protects cookie-authenticated routes against CSRF.
4. The app calls no-store introspection for each protected request and checks exact issuer, audience, profile binding and operation scope. Profile switch, logout or grant loss invalidates both an unused code and every prior token before the next domain operation. The app clears its session when introspection is inactive.

This is a protocol sketch, not an authorized deployment or a working SSO endpoint. The product owner must identify the durable platform user/profile authority and approve the host-to-Control-Plane binding before code can replace the sketch.

## Acceptance evidence

- Two users and two profiles: a code for A never resolves to B, and app-supplied profile fields cannot change either result.
- A switch or logout between code creation and exchange rejects exchange; a switch after exchange makes introspection inactive on the next request.
- Wrong service key, audience, exact redirect URI, CSRF state, PKCE verifier, expired code and replay all fail closed without issuing a token.
- Recruiting and CRM consume the same v1 response but receive separate service credentials and only their own scopes. No Agent Run is launched by browser use.
- A live host/session authority revision, verified old-to-new mapping where needed, deployment IDs, installed secrets, route trace and app request evidence are recorded before enabling either app.
