# Connected App audience-specific entitlements

This source change adds a Control Plane D1 app-entitlement boundary and a prototype first-party Telegram code handoff against the v1 Agent profile-context port. The current adapter and `agent_*` tables are physically CP-hosted; they are not an Agent-owned runtime or canonical identity store. It does not import old Agent usernames or provision real principal/profile memberships. The tables remain empty outside synthetic tests, and deployed Worker flags/migrations are unchanged.

`connected_app_memberships` records an independently reviewed audience-specific entitlement `(principal_id, profile_id, audience, maximum scopes)`. It is not the canonical Agent user/profile membership and cannot establish that relationship. No public route writes this table. Code issuance requires both this CP app entitlement and a current Agent profile context. Code exchange, host issue and every introspection re-resolve the Agent session and compare principal, profile and `profileGeneration`; Agent authority outage returns 503 and authorizes no protected operation. Entitlement changes advance the CP-local generation and invalidate existing codes/tokens on next use.

The `connected_app_sessions` row is a derived app-session projection. It stores the last verified Agent profile generation plus a CP-local generation. `select` is host-only and checks supplied context against the Agent authority; it is not the canonical profile selector or a browser profile-switch endpoint. Switching the Agent profile invalidates app sessions but does not retarget accepted tasks or alter durable schedules.

## Remaining live-source blocker

The current production Worker cannot prove the full tuple `(authenticated Agent principal, canonical profile membership, selected profile, current session/generation)`:

- `admission_principals` authorizes task API callers, which may be services; it has no browser session or canonical profile membership lifecycle.
- Legacy Agent `web_current` is writable by browser JavaScript and selects a legacy per-profile JWT. The Agent does not publish a new principal/session authority.
- `trained-assist-web` `SessionHub` authenticates by delegating a password check to the legacy Agent `/web/verify`, or by a journal ticket. Its cookie resolves to an old username, not a reviewed new principal/profile binding.

## Telegram bootstrap audit

The source bootstrap accepts only an authenticated gateway call representing a private Telegram update, resolves the actor through `agent_telegram_bindings`, and uses one-time challenges plus an HttpOnly browser session. This is currently a CP-hosted prototype. The Agent producer runtime and private reviewed provisioning are not implemented. Existing sandbox `profileForUpdate` mappings and legacy `/login` are not accepted as that crosswalk. The production Telegram gateway must continue to authenticate the original Telegram webhook before forwarding the update; the CP start route itself accepts only its private gateway credential.

The source flow now provides a private-chat-only gateway start, update replay claim, one-use challenge, CSRF-protected completion and Secure HttpOnly session. The Agent module owns actor bindings, canonical profile memberships, selected profile and generation; the Connected App broker reads app grants separately from `connected_app_memberships`. No live mapping, old-user import or public login is established by this code.

The remaining work is private reviewed principal/profile provisioning, deployment of reviewed migrations, per-app BFF acceptance and live verification. Keep the flags disabled until those gates pass. Synthetic Agent memberships in tests verify handler behavior only; they are not evidence of a real-user mapping.
