import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const { createSupervisor } = await import('../src/supervisor.mjs').catch(() => ({}));
const base = tmpdir();
const fixture = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));
export async function setup(t, options = {}) {
  assert.equal(typeof createSupervisor, 'function', 'createSupervisor must be implemented');
  const dir = await mkdtemp(path.join(base, 'copilot-supervisor-test-'));
  const root = path.join(dir, 'project'); await mkdir(root);
  const supervisor = await createSupervisor({ root, stateDir: path.join(dir, 'state'), agentArgv: [process.execPath, fixture], approvalTimeoutMs: 2000, ...options });
  t.after(async () => { await supervisor.close(); await rm(dir, { recursive: true, force: true }); });
  return { root, supervisor };
}
export async function until(read, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('Timed out waiting for expected state');
}

for (const action of ['write', 'command']) {
  test(`real acpx ${action} refusal prevents the actual side effect`, async t => {
    const { root, supervisor } = await setup(t);
    const job = await supervisor.start({ prompt: JSON.stringify({ action, file: 'denied.txt', content: 'must not exist' }) });
    const waiting = await until(() => supervisor.status(job.jobId), x => x.approvals.length === 1);
    supervisor.decide({ jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'deny' });
    const done = await until(() => supervisor.status(job.jobId), x => x.status !== 'running' && x.status !== 'waiting_approval');
    await assert.rejects(access(path.join(root, 'denied.txt')));
    assert.match(done.events.map(x => x.text || '').join(''), /"allowed":false/);
  });
}

test('real acpx command approval dispatches an actual child process', async t => {
  const { root, supervisor } = await setup(t);
  const job = await supervisor.start({ prompt: JSON.stringify({ action: 'command', file: 'command.txt', content: 'actual child process' }) });
  const waiting = await until(() => supervisor.status(job.jobId), x => x.approvals.length === 1);
  await assert.rejects(access(path.join(root, 'command.txt')));
  supervisor.decide({ jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' });
  await until(() => supervisor.status(job.jobId), x => x.status === 'completed');
  assert.equal(await readFile(path.join(root, 'command.txt'), 'utf8'), 'actual child process');
});

test('real acpx cancellation invalidates pending approval and leaves no file', async t => {
  const { root, supervisor } = await setup(t);
  const job = await supervisor.start({ prompt: JSON.stringify({ action: 'write', file: 'cancelled.txt', content: 'never' }) });
  const waiting = await until(() => supervisor.status(job.jobId), x => x.approvals.length === 1);
  await supervisor.cancel(job.jobId);
  assert.equal(supervisor.status(job.jobId).status, 'cancelled', JSON.stringify(supervisor.status(job.jobId)));
  assert.throws(() => supervisor.decide({ jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' }), /expired/);
  await assert.rejects(access(path.join(root, 'cancelled.txt')));
});

test('real acpx approval expiry does not write or accept a stale decision', async t => {
  const { root, supervisor } = await setup(t, { approvalTimeoutMs: 120 });
  const job = await supervisor.start({ prompt: JSON.stringify({ action: 'write', file: 'expired.txt', content: 'never' }) });
  const waiting = await until(() => supervisor.status(job.jobId), x => x.approvals.length === 1);
  await until(() => supervisor.status(job.jobId), x => x.status !== 'running' && x.status !== 'waiting_approval');
  assert.throws(() => supervisor.decide({ jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' }), /expired/);
  await assert.rejects(access(path.join(root, 'expired.txt')));
});

test('real acpx turn timeout cancels pending permission without a write', async t => {
  const { root, supervisor } = await setup(t, { turnTimeoutMs: 150, approvalTimeoutMs: 3000 });
  const job = await supervisor.start({ prompt: JSON.stringify({ action: 'write', file: 'turn-timeout.txt', content: 'never' }) });
  const waiting = await until(() => supervisor.status(job.jobId), x => x.approvals.length === 1);
  const done = await until(() => supervisor.status(job.jobId), x => x.status !== 'running' && x.status !== 'waiting_approval');
  assert.equal(done.approvals.length, 0);
  assert.notEqual(done.status, 'completed', JSON.stringify(done));
  assert.throws(() => supervisor.decide({ jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' }), /expired/);
  await assert.rejects(access(path.join(root, 'turn-timeout.txt')));
});

test('real acpx runtime holds a native file write, approves once, and continues same session', async t => {
  const { root, supervisor } = await setup(t);
  const first = await supervisor.start({ prompt: JSON.stringify({ action: 'write', file: 'approved.txt', content: 'actual-approved-write' }) });
  const waiting = await until(() => supervisor.status(first.jobId), x => x.approvals.length === 1);
  assert.equal(waiting.status, 'waiting_approval');
  await assert.rejects(access(path.join(root, 'approved.txt')));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(supervisor.status(first.jobId).status, 'waiting_approval');
  supervisor.decide({ jobId: first.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' });
  const completed = await until(() => supervisor.status(first.jobId), x => x.status === 'completed');
  assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'actual-approved-write');
  assert.equal(completed.result.status, 'completed');
  const next = await supervisor.start({ sessionId: first.sessionId, prompt: JSON.stringify({ action: 'echo', message: 'follow-up' }) });
  const followup = await until(() => supervisor.status(next.jobId), x => x.status === 'completed');
  const response = followup.events.filter(x => x.type === 'text_delta').map(x => x.text).join('');
  assert.match(response, /follow-up/);
  assert.match(response, /"turns":2/);
  assert.equal(next.sessionId, first.sessionId);
});
