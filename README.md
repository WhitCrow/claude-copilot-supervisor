# Claude–Copilot Supervisor

English | [简体中文](README.zh-CN.md)

A local approval bridge: **Claude Code → MCP → acpx/runtime → GitHub Copilot CLI**.

Claude can delegate tasks, continue the discussion in the same Copilot session, inspect Copilot's tool requests, approve once or deny, and let the executor continue. This does not disguise Copilot as a Claude model and requires neither a public service nor a background daemon.

> **Experimental tool, not a security sandbox.** Current verification covers native file changes, command approvals, and multi-turn context with a restricted tool set. General-purpose `ask_user` / elicitation, cross-process recovery of pending approvals, and genuine mid-turn steering are not implemented. See the [security boundaries](SECURITY.md) and [verification notes](docs/verification.md).

## Architecture

```text
Claude Code
   │ stdio MCP: start / status / decide / cancel / close
   ▼
Local supervisor process
   ├─ Persistent sessions and short-wait status queries
   ├─ Suspended permission callbacks, exact allow_once selection
   ├─ Timeouts, cancellation, shutdown, and resource limits
   ▼
acpx/runtime (createAcpRuntime)
   │ ACP stdio
   ▼
GitHub Copilot CLI
```

ACP and MCP are different protocols; this repository bridges them. It does not listen on TCP/HTTP ports. It is not an official GitHub, Anthropic, or OpenClaw plugin.

### Dependency credit

The embedded ACP runtime is provided by [acpx, maintained by OpenClaw](https://github.com/openclaw/acpx). This project is a new supervisor/MCP bridge built on that dependency, not an acpx fork or a rewrite of its underlying runtime. Dependency licenses remain with their respective projects.

## Installation

Prerequisites:

- Node.js **22.13+** and npm.
- For real use: `copilot` and `claude` on PATH in the same execution environment, each already authenticated.
- A global acpx installation is not required; the project's local dependency supplies the pinned version.

From this repository:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm run check
```

`npm run check` performs syntax checks and tests that do not call models. Tests exercise the mechanisms using an included ACP fixture and fault injection; they do not read personal projects or require model accounts. Temporary files use Node's system temporary-directory resolution, including support for `TMPDIR` / `TMP` / `TEMP`.

If Copilot is not installed, follow the [official installation instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli), then authenticate in your own terminal:

```bash
npm install -g @github/copilot
copilot login --device-code
```

Do not put passwords, tokens, or device codes in this repository, MCP JSON, or prompts. If a credential store is unavailable, the CLI may fall back to storing tokens in plaintext; review the official CLI's storage behavior against your own security requirements before logging in.

## Connect to Claude Code

First create a test project **without secrets or production data**. Copy `examples/mcp.example.json` to your own local configuration (the suggested name `mcp.local.json` is gitignored), and replace every absolute path.

Configuration shape for real Copilot:

```json
{
  "mcpServers": {
    "copilot-supervisor": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/claude-copilot-supervisor/src/server.mjs",
        "--project-root", "/absolute/path/to/empty-test-project",
        "--state-dir", "/absolute/path/to/private-session-state"
      ]
    }
  }
}
```

Then **load it temporarily** in Claude Code without writing global settings:

```bash
claude --strict-mcp-config --mcp-config /absolute/path/to/mcp.local.json
```

`--strict-mcp-config` makes that Claude session load only the explicitly configured MCP servers; it does not change other sessions' settings. Do not authorize an entire server, home directory, or project containing keys.

Suggested supervisor instructions:

```text
Use the copilot-supervisor tools only for the task I explicitly specify.
After starting, query with copilot_status(waitMs=10000); do not busy-poll.
On waiting_approval, inspect the exact paths, diff, or complete command.
Approve once only within the project and task scope I authorized; do not expand permissions.
Deny sudo, credential access, external publication, deployment, and unrelated paths, and explain why.
Verify the actual result when finished, then close the session.
```

These prompts constrain the supervisor's behavior; they are **not enforcement policies at the execution layer**. Do not use model judgment as your only security boundary.

### Demo without real models

Append `--fixture` to the configuration's `args` to use the repository's deterministic test agent. In this mode, the prompt is synthetic test JSON, not natural language, for example:

```json
{"action":"write","file":"probe.txt","content":"approved test"}
```

The fixture **is not Copilot** and does not call a model. Remove `--fixture` to run real Copilot. Do not conflate the two kinds of test evidence.

## MCP tools

| Tool | Input | Behavior |
|---|---|---|
| `copilot_start` | `prompt`, optional `sessionId` | Creates a task or sends the next message in an existing session; returns `jobId` and `sessionId`, waiting only for session preparation, not task completion |
| `copilot_status` | `jobId`, optional `waitMs` (0–10000) | Returns status, bounded output, and the raw pending approval request; returns immediately on an approval request or terminal state |
| `copilot_decide` | `jobId`, `approvalId`, `decision` | `approve` selects exactly the offered `allow_once`; `deny` selects a one-time rejection or cancels the request |
| `copilot_cancel` | `jobId` | Revokes pending approvals and cancels the current turn; cannot undo side effects that have already occurred |
| `copilot_close_session` | `sessionId` | Releases the session and connection; call explicitly when work is finished |

Typical flow:

```text
start → status → waiting_approval → inspect request → decide → status → finished
                    ↑                                          │
                    └──────── if another operation follows ────┘
```

- If `allow_once` is absent, the bridge does not silently substitute `allow_always`.
- Expired, cross-job, and reused approval IDs are rejected.
- `completed` means only that the agent's turn ended, **not that the task succeeded**; a denied operation may still end normally with `end_turn`.
- Session continuation works only within the current process. This prototype does not recover public session IDs or pending Promises after a process restart.

See [docs/protocol.md](docs/protocol.md) for the detailed protocol and lifecycle.

## Operation and limits

```bash
npm start -- --project-root /absolute/path/to/test-project --state-dir /absolute/path/to/private-state
```

This entry point's stdout is reserved for MCP JSON-RPC; it is not an interactive TUI. Do not write debug logs to stdout.

Defaults: 60-second approval lifetime; 5-minute task deadline; 10-second startup handshake budget; 3-second cancellation grace period; at most 4 sessions and 64 retained jobs. The state directory may contain task content or code, must remain private, and must not be committed. The default is the repository's `.state/`; set `--state-dir` explicitly to use another directory.

The current Copilot launch arguments disable built-in GitHub MCP servers and custom instructions, exposing only `view,create,edit,apply_patch,bash`. The acpx client's fs/terminal callbacks are disabled; Copilot's native tools use their own execution path. This is neither a full everyday development tool set nor OS isolation.

Tests have primarily run on Linux/Node 22. Portable temporary-directory handling is not a guarantee of Windows end-to-end compatibility; in particular, process-group termination in the opt-in live scripts has not been verified on Windows.

## Real-model integration tests (explicit opt-in; consumes usage)

```bash
npm run test:live:copilot-files
npm run test:live:copilot-commands
npm run test:live:claude-copilot
```

These respectively test real Copilot's native file permissions, exact command permissions, and real Claude approving real Copilot. They work in fresh temporary test directories, retain private reports, and do not commit real execution logs to Git.

There is also `npm run test:live:claude-fixture`: only the supervisor is real Claude; the executor is still the fixture. Real-model use is kept separate from ordinary regression tests.

## Project layout

```text
src/                 Approval queue, session supervisor, stdio MCP entry point
scripts/             Quality checks, opt-in model integration tests, evidence parsers
test/                Offline regressions and deterministic ACP fixture
examples/            Generic MCP configuration example without credentials
docs/                Protocol and de-identified verification summary
```

## Privacy, publication, and license

This repository contains only implementation, tests, and de-identified documentation—not authentication state, personal configuration, raw conversations, real execution IDs, machine-specific paths, or test logs. Public publication has been explicitly authorized by the owner. Runtime state, authentication files, and real execution logs must still remain private. Source visibility and licensing are separate decisions.

This project is licensed under the [MIT License](LICENSE). Copyright (c) claude-copilot-supervisor contributors. Dependencies retain their respective licenses. This project is not published to npm.
