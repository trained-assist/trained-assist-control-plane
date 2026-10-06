# Connected App approval receipt v1

Status: offline contract plus opt-in Control Plane handler. It is not a grant, membership, deployed identity authority, or permission to write to Weeek.

An application service submits an immutable command payload to `POST /v1/connected-app-approvals/prepare` using its audience-specific service credential and a current CP app token with the command's exact write scope. CP derives principal, profile, session, and generation from the token's current D1 binding. The caller cannot supply those identity fields. The payload is canonicalized and hashed with audience, registered client ID, command ID, and source revision. The returned intent ID is an unguessable pointer, not an approval receipt or provider credential.

The approval URL is hosted on the CP issuer. GET only renders the exact operation and creates a short-lived nonce; it never approves. A same-session/profile POST with matching origin and nonce records confirmation. The confirmation and later receipt issuance each recheck session generation, membership, and exact scope in D1. Selection changes, logout, membership changes, expiry, or scope removal fail closed.

The registered command set is deliberately narrow: `crm.deals.create` for `crm-web`, requiring the same-named scope. App audience, client ID, command ID, canonical operation hash, source revision, and selected profile generation are all bound to the intent. Receipt consumption is a D1 batch with a conditional compare-and-set and durable receipt insert. The exact same consumer request ID can recover the same receipt response after a lost response; a different ID, payload, revision, profile, or generation cannot consume it.

The receipt includes the immutable operation and may contain client data. It is returned only over the authenticated service channel, never in a URL or browser form. Consumers must keep it out of logs and persist it before provider dispatch. CP does not create an atomic transaction with an external provider: a CRM consumer must durably mark dispatch started, perform at most one POST, and reconcile an unknown result without blindly retrying. This receipt does not make an external provider operation exactly-once.

Tests use the actual Worker route, D1 migrations, service handler, and conditional SQL. Only the platform session resolver boundary is supplied by the test for controlled identity cases. The production flag defaults off; no membership or write scope is granted by this contract.
