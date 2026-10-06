# Connected App audience-specific entitlements

This change adds a Control Plane D1 app-entitlement boundary on top of the first-party code handoff. It does **not** identify a signed-in person, import old Agent usernames, enable a Worker route or provision any real entitlement. Production still supplies no `AgentProfileAuthority`; browser authorization and token issuance remain unavailable.

`connected_app_memberships` records an independently reviewed audience-specific entitlement `(principal_id, profile_id, audience, maximum scopes)`. It is not the canonical Agent user/profile membership and cannot establish that relationship. No public route writes this table. Code issuance requires both this CP app entitlement and a current Agent profile context. Code exchange, host issue and every introspection re-resolve the Agent session and compare principal, profile and `profileGeneration`; Agent authority outage returns 503 and authorizes no protected operation. Entitlement changes advance the CP-local generation and invalidate existing codes/tokens on next use.

The `connected_app_sessions` row is a derived app-session projection. It stores the last verified Agent profile generation plus a CP-local generation. `select` is host-only and checks supplied context against the Agent authority; it is not the canonical profile selector or a browser profile-switch endpoint. Switching the Agent profile invalidates app sessions but does not retarget accepted tasks or alter durable schedules.

## Remaining live-source blocker

The current production Worker cannot prove the full tuple `(authenticated Agent principal, canonical profile membership, selected profile, current session/generation)`:

- `admission_principals` authorizes task API callers, which may be services; it has no browser session or canonical profile membership lifecycle.
- Legacy Agent `web_current` is writable by browser JavaScript and selects a legacy per-profile JWT. The Agent does not publish a new principal/session authority.
- `trained-assist-web` `SessionHub` authenticates by delegating a password check to the legacy Agent `/web/verify`, or by a journal ticket. Its cookie resolves to an old username, not a reviewed new principal/profile binding.

## Telegram bootstrap audit

An authenticated Telegram **update** is a possible first-party login channel after additional work, but the current gateway does not establish the new platform principal. Production `trained-assist-tg-bot/src/index.js` rejects updates without the per-bot `X-Telegram-Bot-Api-Secret-Token` before parsing the body. The sandbox slice `src/sandbox-tg/index.js` checks that header only when its secret is configured, so bootstrap must require a configured secret. The sandbox `profileForUpdate` maps an allowlisted **chat** to a configured Control Plane **service** principal and profile; it carries `message.from` but does not bind the Telegram actor to a person/profile. Its update replay record is saved after effects, so it is not an atomic one-time login-code fence. Legacy `/login` verifies an old username/password and stores `telegramUserId` in chat-scoped KV; group logins share that chat state and cannot prove which group member owns the profile.

A Telegram bootstrap is only a possible Agent-platform login channel after its actor-to-principal/profile binding is independently reviewed. It would need a private-chat-only verified update, atomic update replay claim, one-use challenge, CSRF-protected completion and a Secure HttpOnly session. The current gateway/profile mapping does not establish that actor-to-principal binding. No such mapping or login flow is added here.

The remaining implementation is the Agent-owned identity/profile authority and its private typed CP adapter (or a separately deployed authenticated assertion contract), plus private reviewed principal/profile membership provisioning. Until then keep the authority absent and the feature disabled. A synthetic app entitlement or profile context in a test is only a fixture; it is not proof of a real-user mapping.
