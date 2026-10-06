# Connected App membership gate

This change adds a Control Plane D1 membership boundary on top of the first-party code handoff. It does **not** identify a signed-in person, import old Agent usernames, enable a Worker route, or provision any real membership. Production still passes no `PlatformSessionResolver`; browser authorization remains unavailable.

`connected_app_memberships` records an independently reviewed `(principal_id, profile_id, audience)` and the maximum scopes for that pair. No public route writes this table. A trusted identity provisioning process must establish the mapping from an authenticated platform principal to the profile before inserting or enabling a row. Unknown or disabled rows deny selection and code issuance. The resolver's grants and the stored membership are intersected. Exchange, host issuance and every introspection recheck membership, so removal closes existing codes and tokens on their next use.

The existing `connected_app_sessions` row remains the browser session's selected profile and generation. Changing that selection invalidates old codes and tokens. It does not retarget already accepted tasks or alter schedules. `select` is still a host-only compatibility seam and cannot create authority without membership; it is not a browser profile-switch endpoint.

## Remaining live-source blocker

The available stores cannot prove the full tuple `(authenticated new platform principal, verified membership, selected profile, current session)`:

- `admission_principals` authorizes task API callers, which may be services; it has no browser session or membership lifecycle.
- Legacy Agent `web_current` is writable by browser JavaScript and selects a legacy per-profile JWT. The Agent does not publish a new principal/session authority.
- `trained-assist-web` `SessionHub` authenticates by delegating a password check to the legacy Agent `/web/verify`, or by a journal ticket. Its cookie resolves to an old username, not a reviewed new principal/profile binding.

## Telegram bootstrap audit

An authenticated Telegram **update** is a possible first-party login channel after additional work, but the current gateway does not establish the new platform principal. Production `trained-assist-tg-bot/src/index.js` rejects updates without the per-bot `X-Telegram-Bot-Api-Secret-Token` before parsing the body. The sandbox slice `src/sandbox-tg/index.js` checks that header only when its secret is configured, so bootstrap must require a configured secret. The sandbox `profileForUpdate` maps an allowlisted **chat** to a configured Control Plane **service** principal and profile; it carries `message.from` but does not bind the Telegram actor to a person/profile. Its update replay record is saved after effects, so it is not an atomic one-time login-code fence. Legacy `/login` verifies an old username/password and stores `telegramUserId` in chat-scoped KV; group logins share that chat state and cannot prove which group member owns the profile.

A safe bootstrap can avoid the retired GCP VM once the missing binding is reviewed: accept a fresh, secret-verified update only in a private chat where `message.from.id === message.chat.id`; look up a Control Plane-owned reviewed `(bot_id, telegram_user_id) → principal_id` binding and enabled profile membership; atomically claim the `(bot_id, update_id)` and create a short-lived single-use challenge bound to that principal and selected-profile generation; send its link only to the same private chat. A browser GET must not consume the challenge because link previewers fetch it. A CSRF-protected POST consumes it atomically, rotates a Secure HttpOnly platform session, and lets the existing Authorization Code + PKCE handoff run. Replay, expired challenge, changed membership/profile, logout, wrong bot/chat, group messages and failed Telegram delivery must not issue a browser session. No current source provides that reviewed Telegram-user binding, and none is inserted by this PR.

The remaining implementation is a trusted platform session resolver backed by a new or explicitly migrated login authority, plus private membership provisioning after two-source review. Until then keep the Worker resolver null and the feature disabled. A synthetic membership row in a test is only a test fixture; it is not proof of a real-user mapping.
