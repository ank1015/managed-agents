# Session execution host integration

Shared by the minimal-bash and Pi no-compaction Worker hosts. This package handles
runtime discovery, tool transport and callback identity, not credential storage.

Each harness validates its own immutable configuration, including `executionGatewayUrl`,
`machineId` and `executionToken`. The session runtime stores that configuration once in
`runtime_session.config_json`. The host passes its stored config to this adapter
on every submission. No separate token table, credential revision, initialization
method or update method exists.

Before the first tool submission, the host discovers the machine using the
configured HTTPS origin and token, then pins gateway/machine/runtime/application destination in the
`host_execution_runtime` table. Concurrent initial tools share discovery.
The pin is persisted before dispatch, so early callbacks can be admitted safely.
A daemon restart never silently retargets old operations to a new runtime.

Tool workers receive `execution:{gatewayUrl,token,runtimeGeneration}` separately from the
immutable native operation. Callbacks use
`acceptToolCompletion({execution:{gatewayUrl,machineId,runtimeGeneration},completion})`.
The host validates the pinned gateway/machine/runtime, then the driver validates
session/operation/provider/job identity before durable admission.

Credentials never enter model input, native tool input, callback context,
transcripts or diagnostics. The two hosts also redact `executionToken` from
initialization and get-session responses without changing the stored config.

There is no token-update RPC or HTTP endpoint. After gateway rotation, an existing
session still holds its original token and cannot submit new work with it.
Use a new session with the replacement token. Accepted result delivery survives
execution-secret rotation through the signed routing envelope and daemon outbox.
Machine deletion prevents future delivery; an already committing callback cannot
be rolled back.

## Rollout

This is a breaking config/storage contract. Use fresh sessions and deploy matching
hosts and tools. Drain old callbacks before upgrading: their context and existing
runtime pins do not contain the gateway origin. No compatibility migration is
included. The existing gateway and daemon already forward the opaque context.

See the [tool-facing gateway contract](../../apps/tools/GATEWAY-CONTRACT.md) for
the fixed HTTP endpoints, response shapes, authentication and private callback
bindings required from app-owned gateways.
