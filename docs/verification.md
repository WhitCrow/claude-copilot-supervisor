# Verification notes (de-identified summary)

English | [简体中文](verification.zh-CN.md)

## Version baseline

- Node.js 22.23.2 (supported requirement: 22.13+).
- acpx 0.21.0 and MCP SDK 1.32.2.
- Real GitHub Copilot CLI 1.0.103.
- The supervisor was real Claude Code, using an existing official login; no fabricated model responses were used.

This document retains behavioral conclusions only. It contains no accounts, authentication state, hostnames, absolute local machine paths, real session IDs, or raw conversation logs.

## Ordinary regression tests

`npm run check` performs syntax/JSON checks, then runs Node's built-in tests. It does not call real models.

- Approval queue: waiting, exact one-time options, expiry and event-loop delays, cross-job/replay/invalid decisions, and preventing substitution of persistent grants.
- Runtime fixture: real acpx software and an ACP test subprocess, checking actual file/command side effects, cancellation, deadlines, and multi-turn sessions.
- Lifecycle: deterministic runtime fault injection covering shutdown/startup races, admission cancellation, cleanup failures, session limits, synchronous failures, and canonical error preservation.
- MCP: real stdio subprocesses and an MCP client, covering start/status/decide, cancellation, disconnection, and session closure.
- Live evidence: concatenates fragmented `text_delta` values rather than searching for contiguous markers inside JSON-serialized strings.
- File probe policy: requires a previously nonexistent authorized file under the temporary root, an exact `rawInput.fileName`, and all `locations` pointing only to that file. It accepts two strictly constrained create representations: (1) a single structured `content` diff with the exact target path, `oldText` equal to an empty string or `null`, and `newText` equal to the fixed marker with at most one trailing newline and one additional blank line; any `rawInput.content` must match the same allowed text; or (2) the observed native `rawInput.diff` string, matched byte-for-byte against the expected create-file patch, including its headers, target path, fixed marker, and whitespace. The second representation permits only `fileName` and `diff` in `rawInput` and no tool-call `content`. Additional targets, commands, replacements, deletions, and unknown structures are rejected. This is a synthetic live-test policy, not a general patch parser or sandbox. See the implementation in [scripts/live-file-policy.mjs](../scripts/live-file-policy.mjs).
- Forced-cancellation fault injection: when close rejects and events/result never finish, fixes the state as `failed`, retains errors and a retryable handle, checks that late results cannot overwrite the state and that long task timers do not prevent natural subprocess exit; failure to clean up one item does not skip other sessions, processes, or runtime shutdown.
- Runtime version reports: three live scripts populate `runtimeVersions` from the actual local `copilot --version` output for that run and the installed acpx package version. Detection failure records `null` and an error rather than falling back to the historical baseline. Unit tests inject synchronous probes and do not require Copilot to be installed.

These offline mechanism tests must not be described as testing “all real Copilot failure scenarios.”

## Real-model verification already performed

### Copilot native files

1. Native create/edit emitted ACP permission requests containing locations, fileName/diff, and one-time authorization options.
2. After denial, the parent controller confirmed that the target file did not exist.
3. A separate native write was approved once. The file did not exist before approval, and the parent controller read back the expected synthetic content after completion.
4. In the third turn of the same Copilot session, without reading files, Copilot accurately recalled the nonsecret marker from the first turn.

### Claude → MCP → acpx → Copilot

1. Real Claude delegated a natural-language task to real Copilot, without fixture JSON.
2. Claude read real modification requests, denied one, then approved another.
3. When the approve tool call was emitted, the parent process checked that the target file did not yet exist, then independently read back the final content. The denied target never existed.
4. Concatenated third-turn MCP output contained the first-turn marker, and all three start calls returned the same sessionId.
5. Claude explicitly closed the session at the end.

One successful integration run used 11 MCP tool calls, and the supervisor recorded 12 turns. These are observations, not performance or cost guarantees.

### Copilot native commands

Only a single Node command writing fixed content into the temporary test directory was allowed. The deterministic controller compared the requested command with the full expected command: denial created no file; one-time approval produced the expected content. This is neither a general shell safety checker nor an evaluation of Claude's accuracy in reviewing arbitrary commands.

## Not yet covered

- Arbitrary proactive questions, fixed-choice questions, or general-purpose elicitation.
- Arbitrary combinations of plugins, hooks, MCP servers, and saved grants.
- Every real Copilot timeout/disconnection/malicious-backend failure path.
- Full Windows operation, strong OS sandboxing, or isolation from malicious processes running as the same user.
- High concurrency or long-running production operation.

The first real integration verifier incorrectly returned false because of token fragmentation. After fixing the evidence parser and adding regression coverage, the real chain was rerun successfully. A successful model summary cannot replace independent evidence, and failure history must not be erased to claim reliability.

## Rerunning checks

```bash
npm run check
npm audit --omit=dev
```

Real-model scripts run only with explicit opt-in and consume usage. They save reports in fresh private temporary directories; logs are not automatically committed. The repository does not configure cloud model jobs, automatic authentication, or remote CI by default.
