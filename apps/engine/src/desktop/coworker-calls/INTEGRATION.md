# Root integration after the source handoff

The runtime remains inactive until root wires grants, allowed targets and the UI.
Root owns every execution check and native/restart acceptance.

`DesktopCoworkerCallDeps.prepareTarget` is required. It receives:

```ts
{
  caller: { engineAgentId, engineSessionId, engineRunId },
  target: { publicAgentId, engineAgentId }
}
```

It returns `{publicAgentId, engineAgentId, connectionId, model}` only after current
caller/allow-list authorization, exact target identity/enabled/deletion checks,
`assertDesktopSetupChatAllowed(runtime, publicAgentId)` without a session bypass,
and `resolveDesktopChatModel(runtime, targetAgent, null)`. Recheck current owner
and setup authority after awaited model reads. Never fall back to a different
connection or model. The engine checks this before session creation and at each
awaited launch checkpoint; a changed approved model refuses the launch.

The authenticated bridge operation is `prepare-target`, with that exact payload
and result. Every bridge envelope now includes `launchNonce` as well as `epoch`.
Root verifies the current app launch nonce and persisted current epoch. A stale
process cannot adopt or mutate the new process's call state.

`HeadlessRunLifecycle.onRunCreated(runId)` is optional for existing callers but is
required by this runtime's `startChildRun` adapter. It must finish before provider
work begins. The callback saves the exact child ID before nested calls can run;
even a Stop already claimed on the row receives the minted ID before launch is
refused. Never infer a child from whatever run happens to occupy its session.
`assertActive` may return a promise and is awaited at every headless checkpoint.

`cancelChildRun` must cancel and drain that exact owner/run, rejecting if stopping
is not confirmed. Failure cleanup keeps a live row active until cancellation is
confirmed. Progress writes are serialized and caught. A real terminal outcome may
be persisted while a Stop token is held, so an unavailable Stop response cannot
leave a completed child displayed as active.

After the stream ends, the runtime awaits settlement. A trusted
`pendingToolCallId` on the settled outcome is stored privately with
`status: 'waiting-human', phase: 'terminal'`; epoch recovery does not interrupt
that completed turn. Root's read projection checks that exact pending tool-call
identity against current human-request state. Stop must not cancel a later run in
the same conversation when the recorded turn is terminal and waiting for a human.

Private rows also require `requestFingerprint: string`: SHA256 of JSON.stringify
of `{agentRef: trimmedRef, message, context: context ?? '', wait: wait === true}`,
in that field order. Both inflight and durable source-identity replays reject a
different fingerprint. The public snapshot never contains this value.
