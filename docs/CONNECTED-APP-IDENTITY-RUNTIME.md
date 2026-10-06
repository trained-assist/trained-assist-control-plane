# Connected App identity runtime (opt-in)

This slice implements the unchanged `connected-app-identity-v1` introspection response in D1. It is disabled unless `CONNECTED_APP_IDENTITY_ENABLED=true` and has no browser handoff. Do not enable it for end users yet.

Bindings:

- `CONNECTED_APP_HOST_KEY`: a separate random secret of at least 32 characters, held only by the trusted host backend. The host authenticates every select, issue, revoke and disable-principal request with `Authorization: Bearer`.
- `CONNECTED_APP_SERVICE_KEYS`: JSON map of exact `recruiting-web` and `crm-web` audiences to independent random service keys of at least 32 characters. The app backend authenticates introspection with its own key. These are not browser credentials.
- `CONNECTED_APP_ISSUER`: the expected HTTPS issuer URL.

The trusted host calls `POST /v1/connected-app-sessions/select` with `{sessionId,principalId,profileId,enabled,grants}`. The IDs and selected profile must come from its authenticated session authority, never an app request. Each update increments a generation and revokes all earlier tokens for that session. A different principal cannot take over an existing session ID. `POST .../issue` takes `{sessionId,audience,scopes}` and returns an opaque 256-bit token with a one hour lifetime. The host must keep it server side until a one-time browser code exchange exists. `POST .../revoke` takes `{token}`; `POST .../disable-principal` takes `{principalId}`. Both are host only. The audience service calls `POST .../introspect` with `{token,audience}` and receives exactly the v1 active or inactive response, always with `Cache-Control: no-store`. Token hashes, never bearer values, are stored in D1.

The trusted host authentication is a backend credential, not proof that a particular browser selected a profile. Before activation, connect the host call to a real authenticated principal/profile session authority, design and implement one-time browser code exchange, register each app service key in its own secret binding, deploy migration 0015, verify revocation and profile switch against both apps, and record live issuer/release evidence. The existing agent web JWT and run token are not accepted. No production route or deployment is enabled by this PR.
