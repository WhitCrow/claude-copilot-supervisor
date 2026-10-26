# Protocol and lifecycle

English | [简体中文](protocol.zh-CN.md)

## Requests are not background pop-ups

Copilot submits `session/request_permission` over ACP; the embedded runtime's asynchronous `onPermissionRequest` remains pending. This bridge stores the request as an in-memory entry. Claude queries it through MCP, then returns a decision through a separate decide call.

`copilot_start` returns a jobId without waiting for task completion, avoiding a deadlock where the supervisor waits for execution to finish while the executor waits for approval. `copilot_status(waitMs=10000)` waits at most ten seconds and returns immediately on a pending approval or terminal state; it does not remain blocked in a way that prevents approval.

## States

```text
running ──permission request──> waiting_approval
   ↑                                │
   └──────── approve/deny ───────────┘
   │
   ├─ completed: agent turn ended (not necessarily goal achieved)
   ├─ cancelled: cancellation requested and corresponding cleanup completed
   └─ failed: task, timeout, or cleanup failure; error retained
```

A single turn may request permission multiple times. Denial may cause the agent to abandon that operation or end the turn. Real Copilot has returned “Operation cancelled” after denial and still produced a normal `end_turn`, so callers must inspect results and side effects, not just `completed`.

## One-time decisions

- Public approval IDs are random UUIDs bound to jobId.
- A request snapshot is stored internally, and copies are returned for display; external mutation cannot change the stored request.
- `approve` selects only the exact `allow_once` optionId; if that option is absent, it returns an error.
- `deny` selects `reject_once`, or cancels the request if that option is absent; it does not fall back to a persistent rejection option.
- Expired, duplicate, and cross-job decisions never authorize execution.
- Expiry is determined using a monotonic clock and rechecked at the decision entry point; event-loop timers alone are not trusted.

These rules manage the authorization lifecycle in the bridge's software layer. They do not verify that “the operation described by the model” necessarily matches the bytes executed by any arbitrary native backend. See [SECURITY.md](../SECURITY.md) for trust and isolation boundaries.

## Cancellation and shutdown

- If an MCP start request is cancelled while its session is being prepared, admission is revoked and any newly acquired handle is released, leaving no job unknown to the caller.
- After start returns jobId, the independent task continues; use `copilot_cancel` to cancel it explicitly.
- Task and startup handshake deadlines are separate. The host owns the task deadline so that a late `end_turn` cannot overwrite a timeout in a race.
- Cancellation preserves the backend's canonical failure rather than disguising cleanup failure as successful cancellation.
- Once the cooperative cancellation grace period expires, the bridge attempts to close the relevant connection. If cleanup cannot complete, it reports failure and attempts fallback termination of owned processes recorded during the lifecycle.
- Forced cancellation immediately fixes the state as `failed` and clears the host task deadline. Late events, results, or exceptions cannot overwrite that terminal state. The result retains `cancellationError` and `cleanupErrors`; the call itself still throws the cleanup error.
- On forced cancellation or overall shutdown, a session is removed only after `runtime.close` confirms success. A failed handle cannot accept new tasks; `copilot_close_session` can retry release, and overall shutdown also retries. `failed` does not mean that resources have been released.
- stdio EOF, protocol closure, and SIGINT/SIGTERM all enter the same idempotent shutdown flow. It attempts cleanup of all sessions and calls runtime shutdown; failure does not produce a successful exit code.
- Completed writes/commands cannot be undone, and descendants that detach from agent supervision are not guaranteed to be captured.

## Resources and persistence

Defaults are at most four sessions, sixty-four historical jobs, one hundred output events per job, and eight thousand characters per `text_delta`. Output is a bounded window, **not a complete log**. Thinking streams are not returned to the supervisor.

The underlying session store writes to a private state directory that may contain task content or code. Approval Promises and public job/session mappings exist only within the current process. There is no cross-process recovery even if the state files still exist. `close_session` releases the connection but retains the underlying private history; users decide when to safely clean the state directory.

## Current tool selection

Real Copilot launches with `--acp --stdio --disable-builtin-mcps --no-custom-instructions`, with the tool set `view,create,edit,apply_patch,bash`. Agent nested delegation, `web_fetch`, and similar capabilities are not enabled.

The client fs and terminal callbacks supplied by acpx are disabled. Real Copilot's native file/native bash tools have been verified to run through their own execution paths and trigger permission callbacks. This does not mean that every native tool necessarily uses the same callback.

ACP `mode: steer` is queued by this runtime; it must not be described as the GitHub Copilot SDK's immediate mid-turn injection. This repository currently sends only prompts.
