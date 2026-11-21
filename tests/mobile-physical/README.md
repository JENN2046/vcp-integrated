# Mobile physical submission fixture

Use a fresh test directory and a test browser that trusts the generated public fixture CA. The HTTPS proxy, ToolBox, and synthetic Provider bind to loopback. Android can reach HTTPS through an authorized ADB USB reverse for port 18443. Use Node 24 with the repository dependencies, built server addon, and a built PWA.

```bash
bash tests/mobile-physical/setup.sh .runs/mobile-physical/current
node tests/mobile-physical/run.cjs .runs/mobile-physical/current /absolute/path/to/mobile-dist
```

`ready.json` records the HTTPS origin, public CA, fixture attachment, and topic. The service updates `status.json` with HTTP, Work, Journal, attachment, Provider, and tool evidence. Keep the control directory local. It contains synthetic server state and the temporary TLS leaf key.

1. Create the empty `arm-pair` file in the control directory, visit the HTTPS `/__hardware/pair` route, and complete pairing in the UI. The route consumes the arm file.
2. Select **Synthetic lost receipt** and **Sponsor target existing topic**. Attach `fixture-note.txt`, enter `PHYSICAL_ATTACHMENT {{VCPChatCanvas}}`, then send. ToolBox rejects the non-portable placeholder with `DESKTOP_CONTEXT_REQUIRED`. Verify the exact request lookup returns no Work.
3. Close and reopen the same browser profile. On the candidate, verify the text and uploaded attachment are available in the composer. Remove the placeholder, leave `PHYSICAL_ATTACHMENT`, and explicitly send. Verify the reply and open the small attachment from the message.
4. Send `PHYSICAL_LOST_ACK`. The proxy truncates only the original successful HTTP 202 body and holds exact lookups for that request. Verify the UI still reports pending confirmation after closing and reopening the same profile.
5. Create the empty `allow-lookup` file and refresh the UI to allow the ordinary exact lookup to complete. Verify the same request is confirmed. The fixture records HTTP status, Work identity, and counts for the full native model and tool sequence.
6. Copy the final `status.json` locally, then create the empty `stop` file to stop ToolBox and the proxy. Use a fresh control directory and CA for independent runs, or reuse the CA in an otherwise clean control directory to keep the same physical test app trust.

The pre-change PWA can be staged and used independently for steps 1–3. Preserve its status before starting a new candidate. Compare the two server receipts after the candidate finishes.

```bash
node tests/mobile-physical/check-receipts.cjs baseline-server.json candidate-server.json
```

If host inotify capacity is exhausted, the fixture uses polling for JavaScript watchers and permits the two empty-knowledge test watchers to be unavailable. The ToolBox request pipeline, NativeSync, SQLite, and attachment paths still run in the isolated server process.
