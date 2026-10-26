# Security boundaries

English | [简体中文](SECURITY.zh-CN.md)

## What this is not

This is not a sandbox, an arbitrary-shell safety checker, or a security product that guarantees control over every Copilot action. The working directory is a task scope, not a kernel-enforced filesystem boundary. A Git worktree is not security isolation either.

- acpx's `fs:false` / `terminal:false` disable only the ACP client capabilities it provides; native agent tools may use other execution paths.
- MCP tool descriptions and supervisor prompts are not enforcement policies at the execution layer. Do not rely on model approval as your only permissions safeguard.
- Once native shell execution is approved, a command's capabilities depend on the executing user's actual OS permissions. This project has no reliable shell AST/path safety parser.
- Dependencies, model output, repository content, tool results, and hooks may contain prompt injection. They cannot expand the user's authorization.

## Before use

1. Test first in a temporary project without credentials, private data, or production access.
2. Authorize only a specific project and task. Privilege escalation, credential access, publication, and deployment still require an explicit human decision.
3. Inspect Copilot's existing local grants, plugins, hooks, and MCP configuration. The current restricted launch arguments do not prove that the entire environment is trustworthy.
4. For important projects, use execution-layer isolation such as a separate low-privilege user or container. Do not unconditionally mount private SSH/Git/cloud credentials into the agent's environment.
5. Recheck the actual side effects of both denial and approval after software upgrades, enabling new tools, or changing configuration.

## What this project does

- Embeds the real `createAcpRuntime()` rather than simulating terminal clicks.
- Uses stateful, one-time permission callbacks; selects exactly the agent's offered `allow_once` without falling back to persistent authorization.
- Binds requests to jobs, checks expiry using a monotonic clock, and revokes approvals on timeout/cancellation.
- Uses `deny-all` as the underlying default fallback, not `approve-all`.
- Tracks startup admission and revokes tasks still being prepared during shutdown; failure to clean up one resource does not skip other resources.
- Limits session and retained-job counts and provides an explicit release tool.
- Uses stdio transport, with no HTTP/TCP listener or background autostart configuration.

These measures mitigate software lifecycle errors; they **do not replace OS isolation**. Forced termination targets only owned agent processes recorded during their lifecycle; it cannot guarantee cleanup of arbitrary descendants that detach from supervision.

## Credentials and privacy

- Do not put tokens/passwords in prompts, MCP JSON, commits, issues, or logs.
- Use each official CLI's own authentication channel; be aware of fallback behavior that may store credentials in plaintext when a credential store is unavailable.
- Do not copy authentication files into this repository or embed tokens in Git remote URLs.
- `.state/` and temporary real-model reports may contain code, commands, and task content. Keep them private and clean them up as needed.
- `.gitignore` excludes common secrets and runtime artifacts, but is not a guarantee of secret scanning or leak prevention.
- Treat exposed credentials as compromised. Within your authorized scope, revoke/rotate them and verify that the old credentials no longer work; deleting a file or making a repository private does not restore security.

## Reporting problems

The source repository may be public, but runtime state and sensitive reports must remain private. Do not disclose unpatched vulnerabilities, sensitive logs, raw sessions, authentication files, or reports that have not been sanitized in public issues.

Use GitHub **Security → Report a vulnerability** only if private vulnerability reporting is enabled for this repository. This document does not assert that the feature is enabled. If it is unavailable, do not substitute a public issue for a private vulnerability report or assume that a private reporting channel exists. Use a repository-access-controlled channel only if one is actually available and authorized.

No private contact address or external security response service is currently promised, and there is no response-time SLA.
