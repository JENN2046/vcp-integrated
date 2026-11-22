# Shared watch fault verification

The integration probe runs the existing isolated Linux fixture with two sandboxed Electron clients, their native Chat Data Service processes, VCPToolBox and its SQLite writer, the fixture's TLS proxy, and the deterministic loopback model provider. Each run creates disposable profiles. The probe preloads the fixture and changes only its proxy behavior and private backend process for fault injection.

From the repository root in the integration environment, supply the same Node 24, Electron, Xvfb, native dependencies, and sandbox setup used by the regular integration run.

```bash
node --require ./docs/evidence/shared-watch/fault-probe.cjs tests/integration/run.cjs lost-only
```

The probe checks that B catches up on the same durable profile after A commits while B is stopped. It holds B's first pull response after ToolBox reads it, then commits another turn before releasing the response. B must converge in journal order with its cursor at the writer's head and no inbox, outbox, or pending state. The live wake measurement compares sampled durable terminal state at ToolBox with sampled settled History and cursor on B. B remains on another topic through that measurement, so it has no selected-topic observer for the measured conversation. After an SSE socket cut, the fixture rejects B's watch retries while ordinary pull stays reachable. B must converge during the outage and receive a later turn after the watch recovers.

The live policy hook flips read-only, then removes B's grant while a real watch is open. Both watches must invalidate and close within one heartbeat plus 1 s of scheduling tolerance. Read-only reads remain available and ToolBox rejects a config write with 409. The fixture also holds a configuration read that ToolBox authorized before revocation. The desktop must abort it before the normal request timeout, reject a fresh foreground configuration read locally, and return empty execution status with a permission error. A fresh watch receives 403. Restarting ToolBox with the original fixture policy restores the grant, causes an old token to dirty all lanes, and lets B reopen its unchanged profile and reestablish observation.

Coverage is limited to the isolated Linux fixture. Physical devices, the user's browser, and real model providers remain unverified. The receipt includes timing, loaded-source hashes, and process exits. [Recorded fault run](./fault-receipt.json)

## Same-topic renderer visibility

```bash
node --require ./docs/evidence/shared-watch/fault-probe.cjs \
  --require ./docs/evidence/shared-watch/visibility-probe.cjs tests/integration/run.cjs lost-only
```

Both desktops select the same shared topic. The foreground run keeps B focused while A submits through its normal renderer controls. A separate GUI trial attempted an assistant edit through the context menu; the desktop bridge returned `SHARED_NATIVE_ADMISSION_REQUIRED` before a journal mutation. The edit and delete visibility samples therefore publish through ToolBox's authenticated `shared/message` endpoint with A's synthetic binding and the message's current base hash. The independent SQLite reader brackets each write between its last negative query and first positive query, with a nominal 5 ms polling interval. B records the first matching DOM mutation and the second animation-frame callback at which the match still holds. New and edited rows must have the expected content and intersect the chat viewport. The delete sample checks that the same row is absent. Both clocks use the same host. Reported ranges use the actual journal bracket and round to whole milliseconds. The post-benchmark run independently brackets the durable History update on B to separate synchronization time from the renderer's delay. Animation-frame callbacks establish renderer readiness. Physical monitor presentation time remains unmeasured.

The receipt retains the earlier new-message trial with A brought to the foreground and the foreground-B trial that encountered the GUI edit refusal. Both new-message trials exceeded one second. Examples come from isolated Electron processes on the Linux host while independent benchmark fixtures were also running. [Renderer visibility receipt](./visibility-receipt.json)
