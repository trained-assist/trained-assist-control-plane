# Connected App membership gate

This change adds a Control Plane D1 membership boundary on top of the first-party code handoff. It does **not** identify a signed-in person, import old Agent usernames, enable a Worker route, or provision any real membership. Production still passes no `PlatformSessionResolver`; browser authorization remains unavailable.

`connected_app_memberships` records an independently reviewed `(principal_id, profile_id, audience)` and the maximum scopes for that pair. No public route writes this table. A trusted identity provisioning process must establish the mapping from an authenticated platform principal to the profile before inserting or enabling a row. Unknown or disabled rows deny selection and code issuance. The resolver's grants and the stored membership are intersected. Exchange, host issuance and every introspection recheck membership, so removal closes existing codes and tokens on their next use.

The existing `connected_app_sessions` row remains the browser session's selected profile and generation. Changing that selection invalidates old codes and tokens. It does not retarget already accepted tasks or alter schedules. `select` is still a host-only compatibility seam and cannot create authority without membership; it is not a browser profile-switch endpoint.

## Remaining live-source blocker

The available stores cannot prove the full tuple `(authenticated new platform principal, verified membership, selected profile, current session)`:

- `admission_principals` authorizes task API callers, which may be services; it has no browser session or membership lifecycle.
- Legacy Agent `web_current` is writable by browser JavaScript and selects a legacy per-profile JWT. The Agent does not publish a new principal/session authority.
- `trained-assist-web` `SessionHub` authenticates by delegating a password check to the legacy Agent `/web/verify`, or by a journal ticket. Its cookie resolves to an old username, not a reviewed new principal/profile binding.

The remaining implementation is a trusted platform session resolver backed by a new or explicitly migrated login authority, plus private membership provisioning after two-source review. Until then keep the Worker resolver null and the feature disabled. A synthetic membership row in a test is only a test fixture; it is not proof of a real-user mapping.
