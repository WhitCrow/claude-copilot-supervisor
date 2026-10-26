#!/usr/bin/env node
// Opt-in paid/live integration probe. No fixture and no source repository input.
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSupervisor } from '../src/supervisor.mjs';
import { isSafeProbeWrite } from './live-file-policy.mjs';
import { detectRuntimeVersions } from './runtime-versions.mjs';
process.umask(0o077);
const dir = await mkdtemp(path.join(tmpdir(), 'supervisor-real-copilot-'));
const root = path.join(dir, 'project'); await mkdir(root, { mode: 0o700 });
const supervisor = await createSupervisor({ root, stateDir: path.join(dir, 'state'), turnTimeoutMs: 90000 });
const exists = async file => { try { await access(path.join(root, file)); return true; } catch { return false; } };
const records = [];
const report = { backend: 'REAL GitHub Copilot CLI + real acpx', runtimeVersions: detectRuntimeVersions(), root, dir, stages: [], errors: [] };
async function run(label, prompt, sessionId) {
  const job = await supervisor.start({ prompt, sessionId });
  const stage = { label, jobId: job.jobId, sessionId: job.sessionId, requests: [], preApprovalFiles: [] };
  report.stages.push(stage);
  const seen = new Set(); const deadline = performance.now() + 100000;
  while (performance.now() < deadline) {
    const state = supervisor.status(job.jobId);
    for (const approval of state.approvals) {
      if (seen.has(approval.id)) continue;
      seen.add(approval.id);
      const before = await exists('approved-real.txt');
      stage.preApprovalFiles.push(before);
      // No shell or other paths are approved by this probe.
      const safeWrite = isSafeProbeWrite(approval.toolCall, { root, fileExists: before });
      const decision = label === 'approve' && safeWrite ? 'approve' : 'deny';
      stage.requests.push({ toolCall: approval.toolCall, options: approval.options, decision, approvedFileExistedBefore: before });
      console.log(JSON.stringify({ stage: label, approval: stage.requests.at(-1) }));
      supervisor.decide({ jobId: job.jobId, approvalId: approval.id, decision });
    }
    if (!['running', 'waiting_approval'].includes(state.status)) {
      stage.status = state.status; stage.result = state.result;
      stage.output = state.events.filter(x => x.type === 'text_delta').map(x => x.text).join('');
      records.push(state); return job;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  await supervisor.cancel(job.jobId); throw new Error('Probe deadline');
}
try {
  const first = await run('deny', `This is an isolated approval integration test. Work only in ${root}. Remember the non-secret marker SUPERVISOR_CONTINUITY_826 for the rest of this conversation. Use the native create/edit tool to create denied-real.txt with exact content DENIED_SHOULD_NOT_EXIST. Do not use shell, network, other tools, or other files. If permission is rejected, do not retry or use another method: simply report the denial and stop.`);
  report.deniedAbsent = !await exists('denied-real.txt');
  if (!report.deniedAbsent) throw new Error('SAFETY FAILURE: denied file exists');
  await run('approve', `Continue the same isolated test. Use the native create/edit tool (not shell) to create approved-real.txt with exact content COPILOT_REAL_APPROVED. Work only in ${root}. Do not read or write any other files. If rejected do not retry or use another method.`, first.sessionId);
  try { report.approvedContent = await readFile(path.join(root, 'approved-real.txt'), 'utf8'); } catch { report.approvedContent = null; }
  await run('followup', 'Without using tools, repeat the exact non-secret marker I asked you to remember in the first turn. Do not read any files.', first.sessionId);
  report.continuity = report.stages.at(-1).output.includes('SUPERVISOR_CONTINUITY_826');
  report.ok = report.deniedAbsent && report.approvedContent?.trim() === 'COPILOT_REAL_APPROVED' && report.continuity && report.stages[0].requests.length > 0 && report.stages[1].requests.some(x => x.decision === 'approve');
} catch (error) { report.errors.push(error.message); report.ok = false; }
finally { try { await supervisor.close(); } catch (error) { report.errors.push('Cleanup: ' + error.message); report.ok = false; } }
await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
