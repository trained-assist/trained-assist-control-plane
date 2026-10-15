# MCP Host user catalog in sandbox OpenCode runs

Issue: [trained-assist-mcp-host#35](https://github.com/trained-assist/trained-assist-mcp-host/issues/35).

The Telegram UX sandbox profile now has a host-owned option to attach the user MCP catalog as a remote server in RunSpec. The selected descriptor is fixed in `src/router/user-sandbox-mcp.ts`; inbound task text cannot select the server, URL, binding, tools, catalogue digest, or identity. Runner resolves the actual Run ID and signs a short-lived grant using its trusted profile-to-user mapping. The user Worker checks the signature and active user for each MCP request. CP does not receive a personal user API key or Runner's signing key.

The currently approved catalog contains `identity.whoami`, `google_docs.connect`, and `google_docs.get_document`. Google Docs calls still require that the sandbox user's OAuth connection is configured and should be tested live before claiming document access works.

OpenCode's built-in `websearch`/`webfetch`, shell, and code tools remain OpenCode-native capabilities. The user's `engineering-checklists` desktop entry is local and has its own scoped service credential; it must not be copied to France VM/GHA/Azure. A remote or runner-local service integration for that capability is still outstanding. This change attaches the complete **current MCP Host user catalog**, not every desktop MCP entry.

Production profile selection, keys, user mapping, and deployments are intentionally unchanged. Full completion requires sandbox secret provisioning, live CP→Runner→OpenCode calls on the France and GHA/Azure workers, actual user-catalog `tools/list` plus a permitted tool call, and validation that OpenCode native web search is available on each runtime.
