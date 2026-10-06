# Connected App profile authority gate

Status: blocked for live browser issuance. This note follows the opt-in D1 issuer in PR #68. It does not change the version 1 contract or enable a route.

## Source audit

The platform contract [C14](https://github.com/trained-assist/trained-agent-architecture/blob/main/contracts/C14-CONNECTED-APPLICATION.md) requires a platform-authenticated user and a selected profile that the app cannot choose. The currently available stores do not yet provide that complete tuple:

| Source | What it proves | Missing for Connected Apps |
| --- | --- | --- |
| Control Plane `admission_principals` (`migrations/0002_task_admission.sql`, `src/intake/authorization.ts`) | An authenticated API caller may be bound to one `profile_id` and task scopes. It is used for task admission. | No browser session, selected-profile transition, user/profile membership or guarantee that the caller is an end-user rather than a gateway/service principal. It cannot be treated as the Connected App user authority. |
| Legacy Agent `src/web-auth.js` | A per-profile JWT can authenticate a legacy web request; `web_current` selects a per-profile cookie. | The selector is readable and writable by browser JS. The old JWT and cookie are explicitly excluded by identity v1. This state does not provide the new platform principal/session lifecycle. |
| `trained-assist-web/worker.mjs` `SessionHub` | Its Durable Object maps its own cookie to a `username` after legacy `/web/verify` or a signed journal ticket. | Authentication still delegates to the legacy agent password store. The stored username is not a verified new principal/profile binding; logout and profile changes are not invalidated in Control Plane. |
| CP-hosted prototype `src/agent-profile-authority/v1.ts` + migration `0021_agent_profile_authority_v1.sql` | Exercises contract-shaped Telegram actor binding, profile selection, browser session and generation. Synthetic Worker tests cover two principals, profile selection, replay, logout, profile removal and app-grant separation. | The Agent producer runtime is not implemented; these CP tables are not canonical Agent membership. No private real-user binding or membership rows are provisioned; the prototype is not deployed and cannot authenticate a real owner. |
| Control Plane `connected_app_sessions` | Stores the broker's derived app-session tuple and invalidates tokens on broker updates. | The host credential and CP app-grant rows still cannot establish canonical Agent membership. Both Agent bootstrap and broker flags remain off in the deployed Worker. |

Do not import `admission_principals` as a user directory or copy a legacy username into `profileId`. A verified old-to-new principal/profile mapping and an authenticated selected-profile session source are prerequisites. This also blocks automatic CRM old `USER_ID` linkage.

## Required authority port

The Agent identity/profile authority owns the durable authenticated-user → profile membership and selected-profile binding/generation. It may be a separately versioned module inside the supported Agent Control Plane Worker; the Connected App broker consumes a private typed `AgentProfileAuthority` port. The port returns `{principalId, profileId, sessionId, profileGeneration}` from a verified Agent session. It does not take identity from app JSON, query parameters, legacy `web_current`, model payload or an Agent Run ID. The broker checks this context at browser authorization, code exchange, host issue and every introspection, and separately intersects it with the CP audience-specific app entitlement. If Agent authority is unavailable, protected access fails closed with a typed 503.

The CP `select` endpoint is a backend integration seam only. Its profile fields must exactly match a fresh Agent authority result; the CP D1 `connected_app_memberships` rows are only app-specific entitlements, not canonical profile membership. No browser or connected app service may hold `CONNECTED_APP_HOST_KEY` or call `select`/`issue`.

## Authorization Code + PKCE S256 handoff in gated source

Use the first-party confidential BFF pattern from [RFC 10017 §6.1](https://www.rfc-editor.org/rfc/rfc10017.html#section-6.1) and the code-flow protections in [RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1). The initial Control Plane code slice uses standard `response_type=code`, `client_id`, exact `redirect_uri`, `scope`, `state`, `code_challenge_method=S256` and `code_verifier` fields. Until metadata, client registration and the host authority adapter are completed, it is a closed first-party profile of Authorization Code + PKCE, not a general OAuth/OIDC server.

1. The BFF creates a fresh high-entropy `state` and PKCE `code_verifier`, stores both in its server-side browser transaction, and sends `code_challenge=BASE64URL(SHA256(code_verifier))` to the platform authorization endpoint. The platform resolves the authenticated user's current profile through the authority port and records a random code **hash** bound to session, profile generation, confidential client/audience, exact registered redirect URI, CSRF state, S256 challenge and a short expiry (for example 60 seconds). The code is single use.
2. The browser is redirected to that exact registered app callback with code, state and issuer identifier. No bearer token, profile ID or old agent cookie is placed in the URL. The BFF checks stored state and issuer, then exchanges the code with its client credential and PKCE verifier. Wrong client, redirect, state, verifier, expired code and replay fail before any token is issued.
3. Control Plane rechecks current Agent principal/profile/session generation and CP app entitlement, then atomically consumes the code and issues the opaque audience-bound token to the **BFF**. The BFF holds it server side behind an HttpOnly, Secure, SameSite session cookie; browser JavaScript never receives the token. The BFF protects cookie-authenticated routes against CSRF.
4. The app calls no-store introspection for each protected request and checks exact issuer, audience, profile binding and operation scope. Profile switch, logout or grant loss invalidates both an unused code and every prior token before the next domain operation. The app clears its session when introspection is inactive.

The authorization code, PKCE exchange, CP-hosted prototype resolver and Telegram bootstrap are implemented in source and exercised through real Worker routes with disposable D1 state. This is not an Agent producer implementation or a deployed/populated SSO endpoint. Live issuance remains disabled until the Agent resolver is implemented and bound, private principal/profile rows are reviewed and provisioned, migrations are deployed, each app BFF is bound, and live outage/revocation checks pass.

## Acceptance evidence

- Offline Worker tests use two synthetic principals and multiple profiles: a browser for A cannot select B's profile, and app-supplied profile fields cannot change the Agent context.
- A switch or logout between code creation and exchange rejects exchange; a switch after exchange makes introspection inactive on the next request.
- Wrong service key, audience, exact redirect URI, CSRF state, PKCE verifier, expired code and replay all fail closed without issuing a token.
- Recruiting and CRM consume the same v1 response but receive separate service credentials and only their own scopes. No Agent Run is launched by browser use.
- A live host/session authority revision, verified old-to-new mapping where needed, deployment IDs, installed secrets, route trace and app request evidence are recorded before enabling either app.
