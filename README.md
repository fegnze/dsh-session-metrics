# DSH Session Metrics

English | [中文](<docs/zh.md>)

`dsh-session-metrics` is a community desktop plugin (not an official DeepSeek product) for DSH 0.2.0-rc.2 and 0.2.1-rc.2. It replaces DSH's shipped statistics band below the composer with one row showing billed tokens, context usage, cache hit, model time, the running turn's model time, tool time, turns and steps; everything else lives in a hover panel. It modifies no core code, writes no files, and starts no separate service.

## Behavior

- The Host subscribes to `session/event` and folds the durable log into per-Session counters: `turn/start` and `step/start` drive the turn and step counts, `step/start` to `assistant/message` is the model wall time for one step, and `tool/call`/`tool/result` pairs give per-tool call counts and durations.
- Every figure is a delta between log commit timestamps, not an observer's wall clock. A Session that already existed when the plugin loaded is backfilled from `session.snapshotEvents()`, and each later append is folded exactly once by `seq`; a Session disposed in the Host is dropped from memory.
- The row reads the shipped `contextPressure`, `sessionStats` and `tokenUsage` projections, so its figures match DSH's own and update live. `本轮模型` is the turn-scoped model time: the running turn's charged and in-flight model time, or the most recently closed turn's while idle. Hovering (or focusing/clicking) the row opens a panel styled like the shipped stat dialog: tool-call count and failures, the turn's model time, Session span, context use and its breakdown, the token split, and the top tools by accumulated time. Token and context figures use k/M units with each part shown as a share. It closes on Escape, an outside press, or when the pointer leaves.
- The Host route supplies only what the projections lack (tool-call count, per-tool times, failures, Session span, the turn-scoped model time). It is polled every 2.5 seconds while the page is visible, because the row itself carries the turn figure; polling pauses while the page is hidden.
- If neither the projections nor the Host have data, the row stays hidden.
- The local `/myspace-session-metrics/api` route accepts only loopback, a valid Host, same-origin Origin/Fetch Metadata, and the `X-DSH-Session-Metrics: 1` header, and only `GET` with a validated `sessionId`. Counters live in memory and are lost when the plugin unloads or DSH restarts; nothing is written to disk.
- The row registers as `id: stats` at `priority: -1` in `conversation.composer.dock`, shadowing the legacy shipped stats cell. On newer DSH, empty overrides at the same priority also shadow the split `activity` and `usage` cells, preventing duplicate statistics without hiding other plugins' dock entries. The legacy context meter beside the slot is hidden because its figure is in the row. The root keeps the shipped `data-composer-stats` hook so themes style one band with one top rule. Disabling the plugin releases all overrides and restores the shipped statistics and meter.

## Development and installation

Install the npm package `dsh-session-metrics` through the DSH plugin manager. Only the desktop profile is supported; do not install it in the Web profile.

No build is required; the native ModuleLoader Client ships in the package. For development, install `link:/absolute/path/to/dsh-session-metrics` and restart DSH after Host changes, because the Host module cache is not reloaded by a page refresh.

```sh
npm test
node --check src/client.js
```

Tests cover the log fold (turn/step/model/tool accounting, turn-scoped model time, unterminated tool calls, replay idempotence, formatting), the Host route boundary (Session-id validation, loopback/same-origin/header gate, tracker backfill, disposal), and the Client half (the bundle loads through the ModuleLoader seam, shadows the shipped stats cell, renders the row from the shipped projections plus the Host's turn figure, falls back to the Host reading, stays empty for an empty Session or an unreachable Host, and skips polling while the page is hidden). Runtime acceptance on a live DSH desktop session — the row and the hover panel — must be verified separately; passing unit tests is not runtime acceptance.

## Limitations

- Token counts are reported by the provider; a step without a `usage` record contributes duration but no tokens, and the cache-hit share stays `—` instead of showing a made-up percentage.
- Tool durations cover only calls that both started and ended inside the observed log; a call still open when its turn closes is counted as one failed call.
- `本轮模型` follows the whole-log model figure: a turn whose steps assemble no assistant message (cancelled mid-stream, for example) charges no model time, so between turns the item keeps the last closed turn's value.
- Counters start from the Session log the Host can see. A Session restored from storage without its events replayed contributes only its new appends.
- The Host reading is a polled read of local counters; it is not a tracing or billing source, and it does not upload anything.

## Trusted publishing

[The publishing workflow](<.github/workflows/publish.yml>) uses GitHub Actions OIDC without storing an npm token. Run it manually on `main` with the reviewed full commit SHA in `expected_sha`. `dry_run` defaults to true; set it to false only for an approved new-version publication. The workflow rejects a mismatched SHA before publishing. Committing the workflow does not configure the npm Trusted Publisher; do that in the package settings on npmjs.com.

## License

MIT; see [LICENSE](<LICENSE>).
