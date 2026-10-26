#!/usr/bin/env node
// Opt-in real Copilot native command permission test, only deterministic Node writes.
import { mkdtemp, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSupervisor } from '../src/supervisor.mjs';
import { detectRuntimeVersions } from './runtime-versions.mjs';
process.umask(0o077);
const dir = await mkdtemp(path.join(tmpdir(), 'supervisor-copilot-commands-'));
const root = path.join(dir, 'project'); await mkdir(root, { mode: 0o700 });
const supervisor = await createSupervisor({ root, stateDir: path.join(dir, 'state'), turnTimeoutMs: 90000 });
const exists = async file => { try { await access(path.join(root, file)); return true; } catch { return false; } };
const report = { backend: 'real Copilot native bash via ACP + real acpx', runtimeVersions: detectRuntimeVersions(), dir, root, stages: [], errors: [] };
async function run(label, sessionId) {
  const target = path.join(root, label === 'approve' ? 'approved-command.txt' : 'denied-command.txt');
  const command = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(target)},"REAL_COMMAND_APPROVED")'`;
  const prompt = `This is an isolated command-permission test. Use the native bash tool to execute EXACTLY the following single command, with no prefix/suffix or other commands:\n${command}\nDo not use any other tools, do not inspect files or configuration. If the tool is denied, do not retry or switch tools: report the denial and stop. No operations outside this command are authorized.`;
  const job = await supervisor.start({ prompt, sessionId });
  const stage = { label, jobId: job.jobId, sessionId: job.sessionId, expectedCommand: command, requests: [] }; report.stages.push(stage);
  const seen = new Set(); const deadline = performance.now() + 100000;
  while (performance.now() < deadline) {
    const state = supervisor.status(job.jobId);
    for (const request of state.approvals) {
      if (seen.has(request.id)) continue; seen.add(request.id);
      const input = request.toolCall.rawInput;
      const actual = typeof input === 'object' && input !== null ? input.command : undefined;
      const before = await exists(path.basename(target));
      const decision = label === 'approve' && request.toolCall.kind === 'execute' && actual === command && !before ? 'approve' : 'deny';
      stage.requests.push({ toolCall: request.toolCall, decision, fileExistedBefore: before, exactCommandMatch: actual === command });
      console.log(JSON.stringify({ stage: label, permission: stage.requests.at(-1) }));
      supervisor.decide({ jobId: job.jobId, approvalId: request.id, decision });
    }
    if (!['running', 'waiting_approval'].includes(state.status)) {
      stage.status = state.status; stage.result = state.result;
      stage.output = state.events.filter(x => x.type === 'text_delta').map(x => x.text).join(''); return job;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  await supervisor.cancel(job.jobId); throw new Error('Live command probe deadline');
}
try {
  const first = await run('deny');
  report.deniedFileAbsent = !await exists('denied-command.txt');
  if (!report.deniedFileAbsent) throw new Error('Denied command produced a file');
  await run('approve', first.sessionId);
  try { report.approvedContent = await readFile(path.join(root, 'approved-command.txt'), 'utf8'); } catch { report.approvedContent = null; }
  report.ok = report.deniedFileAbsent && report.approvedContent === 'REAL_COMMAND_APPROVED' && report.stages[0].requests.length > 0 && report.stages[1].requests.some(x => x.decision === 'approve' && x.exactCommandMatch && !x.fileExistedBefore);
} catch (error) { report.ok = false; report.errors.push(error.message); }
finally { try { await supervisor.close(); } catch (error) { report.ok = false; report.errors.push(error.message); } }
await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
