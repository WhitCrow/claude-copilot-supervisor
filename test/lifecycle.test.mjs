import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSupervisor } from '../src/supervisor.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function fakeRuntime(overrides = {}) {
  let n = 0;
  return {
    async ensureSession() { return { id: ++n }; },
    startTurn() { return { promptStarted: Promise.resolve(), events: (async function* () {})(), result: Promise.resolve({ status: 'completed', stopReason: 'end_turn' }), cancel: async () => {} }; },
    close: async () => {}, shutdown: async () => {}, ...overrides
  };
}
async function setup(t, runtime, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'supervisor-lifecycle-'));
  const s = await createSupervisor({ root: dir, stateDir: path.join(dir, 'state'), runtimeFactory: () => runtime, ...options });
  t.after(async () => { await s.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return s;
}

test('close revokes a start still preparing a session before it can submit a turn', async t => {
  const gate = deferred(); const entered = deferred(); const calls = [];
  const runtime = fakeRuntime({
    async ensureSession() { entered.resolve(); return await gate.promise; },
    startTurn() { calls.push('startTurn'); return fakeRuntime().startTurn(); },
    async close({ handle }) { calls.push(`close-${handle.id}`); },
    async shutdown() { calls.push('shutdown'); }
  });
  const s = await setup(t, runtime);
  const pending = s.start({ prompt: 'test' });
  const rejected = assert.rejects(pending, /closed|cancel/i);
  await entered.promise;
  const closing = s.close();
  gate.resolve({ id: 'late' });
  await rejected; await closing;
  assert.equal(calls.includes('startTurn'), false);
  assert.ok(calls.includes('close-late'));
  assert.ok(calls.includes('shutdown'));
});

test('request cancellation during preparation never admits an orphan job', async t => {
  const gate = deferred(); const entered = deferred(); const calls = [];
  const s = await setup(t, fakeRuntime({
    async ensureSession() { entered.resolve(); return await gate.promise; },
    startTurn() { calls.push('startTurn'); return fakeRuntime().startTurn(); },
    async close() { calls.push('close'); }
  }));
  const controller = new AbortController();
  const pending = s.start({ prompt: 'test', signal: controller.signal });
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await entered.promise; controller.abort(); gate.resolve({ id: 'cancelled' });
  await rejected;
  assert.deepEqual(calls, ['close']);
});

test('one cleanup failure still attempts all sessions and runtime shutdown', async t => {
  const calls = []; let count = 0;
  const s = await setup(t, fakeRuntime({
    async close({ handle }) { calls.push(handle.id); if (++count === 1) throw new Error('cleanup failed'); },
    async shutdown() { calls.push('shutdown'); }
  }));
  await s.start({ prompt: 'first' }); await tick();
  await s.start({ prompt: 'second' }); await tick();
  await assert.rejects(s.close(), /cleanup/);
  assert.deepEqual(calls, [1, 2, 'shutdown']);
  await assert.rejects(s.close(), /cleanup/);
  assert.deepEqual(calls, [1, 2, 'shutdown']);
});

test('shutdown deletes only released sessions and retains failed handles for explicit cleanup', async t => {
  const calls = []; let rejectClose = true;
  const s = await setup(t, fakeRuntime({
    async close({ handle }) { calls.push(handle.id); if (handle.id === 1 && rejectClose) throw new Error('release failed'); },
    async shutdown() { calls.push('shutdown'); }
  }));
  const first = await s.start({ prompt: 'first' }); await tick();
  const second = await s.start({ prompt: 'second' }); await tick();
  await assert.rejects(s.close(), /cleanup/);
  assert.deepEqual(calls, [1, 2, 'shutdown']);
  await assert.rejects(s.closeSession(second.sessionId), /Unknown session/);
  rejectClose = false;
  await s.closeSession(first.sessionId);
  assert.deepEqual(calls, [1, 2, 'shutdown', 1]);
});

test('force-stop failure still attempts every owned process and preserves cleanup errors', async t => {
  const kills = [];
  t.mock.method(process, 'kill', pid => {
    kills.push(pid);
    if (pid === 111001) throw Object.assign(new Error('injected kill failure'), { code: 'EPERM' });
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'supervisor-force-stop-'));
  const runtime = fakeRuntime({ async shutdown() { throw new Error('injected runtime shutdown failure'); } });
  const s = await createSupervisor({ root: dir, stateDir: path.join(dir, 'state'), runtimeFactory: options => {
    for (const pid of [111001, 111002]) options.processLifecycle.onSpawned({ launchId: String(pid), pid, scope: { kind: 'runtime-session', sessionKey: 'synthetic-session' } });
    return runtime;
  } });
  t.after(async () => { await s.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const error = await s.close().then(() => assert.fail('shutdown must not claim success'), error => error);
  assert.deepEqual(kills, [111001, 111002]);
  assert.ok(error instanceof AggregateError);
  assert.match(error.errors.map(error => error.message).join(' '), /runtime shutdown failure/);
  assert.match(error.errors.map(error => error.message).join(' '), /force.stop/i);
});

test('real Copilot launch disables external MCPs and custom instructions and narrows tools', async t => {
  let captured;
  const runtime = fakeRuntime();
  const dir = await mkdtemp(path.join(tmpdir(), 'supervisor-launch-policy-'));
  const s = await createSupervisor({ root: dir, stateDir: path.join(dir, 'state'), runtimeFactory: options => { captured = options; return runtime; } });
  t.after(async () => { await s.close(); await rm(dir, { recursive: true, force: true }); });
  const argv = captured.agentRegistry.resolve('copilot');
  assert.ok(Array.isArray(argv));
  assert.ok(argv.includes('--disable-builtin-mcps'));
  assert.ok(argv.includes('--no-custom-instructions'));
  assert.ok(argv.includes('--available-tools=view,create,edit,apply_patch,bash'));
  assert.equal(captured.permissionMode, 'deny-all');
});

test('a synchronous backend start failure releases its unreturned session', async t => {
  const calls = [];
  const s = await setup(t, fakeRuntime({ startTurn() { throw new Error('backend start failed'); }, close: async ({ handle }) => calls.push(handle.id) }), { maxSessions: 1, turnTimeoutMs: 30 });
  await assert.rejects(s.start({ prompt: 'first' }), /backend start failed/);
  await assert.rejects(s.start({ prompt: 'second' }), /backend start failed/);
  assert.deepEqual(calls, [1, 2]);
});

test('session capacity is bounded and explicit close releases a slot', async t => {
  const s = await setup(t, fakeRuntime(), { maxSessions: 1 });
  const first = await s.start({ prompt: 'first' }); await tick();
  await assert.rejects(s.start({ prompt: 'second' }), /session limit/i);
  await s.closeSession(first.sessionId);
  const next = await s.start({ prompt: 'third' });
  assert.notEqual(next.sessionId, first.sessionId);
});

test('cancellation has a short grace period then closes the owned connection', async t => {
  const end = deferred(); const calls = [];
  const s = await setup(t, fakeRuntime({
    startTurn() { return { promptStarted: Promise.resolve(), events: (async function* () { await end.promise; })(), result: end.promise, cancel: () => new Promise(() => {}) }; },
    async close() { calls.push('closed'); end.resolve({ status: 'cancelled' }); }
  }), { cancelGraceMs: 25, shutdownGraceMs: 200 });
  const job = await s.start({ prompt: 'test' });
  const result = await Promise.race([s.cancel(job.jobId), new Promise(resolve => setTimeout(() => resolve('HUNG'), 300))]);
  assert.notEqual(result, 'HUNG');
  assert.deepEqual(calls, ['closed']);
  assert.equal(result.status, 'failed');
});

test('failed forced cancellation preserves terminal failure and a retryable cleanup handle', async t => {
  const end = deferred(); const calls = []; let rejectClose = true;
  const s = await setup(t, fakeRuntime({
    startTurn() { return {
      promptStarted: Promise.resolve(), events: (async function* () { await end.promise; })(),
      result: end.promise, cancel: () => new Promise(() => {})
    }; },
    async close({ handle }) { calls.push(handle.id); if (rejectClose) throw new Error('injected connection release failure'); }
  }), { cancelGraceMs: 10, shutdownGraceMs: 10, turnTimeoutMs: 100 });
  const job = await s.start({ prompt: 'test' });
  await assert.rejects(s.cancel(job.jobId), /cleanup/);
  const failed = s.status(job.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result.status, 'failed');
  assert.match(failed.result.cancellationError, /deadline/);
  assert.ok(failed.result.cleanupErrors.some(error => /injected connection release failure/.test(error)));
  await assert.rejects(s.start({ sessionId: job.sessionId, prompt: 'must not reuse broken connection' }), /closing/);
  rejectClose = false;
  assert.deepEqual(await s.closeSession(job.sessionId), { sessionId: job.sessionId, closed: true });
  assert.deepEqual(calls, [1, 1]);
  // A late result (including after the old turn deadline) cannot overwrite the forced terminal state.
  await new Promise(resolve => setTimeout(resolve, 120));
  end.resolve({ status: 'completed' }); await tick();
  assert.deepEqual(s.status(job.jobId), failed);
});

test('forced failure releases turn deadlines even when the event stream and result never settle', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'supervisor-deadline-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict';
    import { createSupervisor } from ${JSON.stringify(new URL('../src/supervisor.mjs', import.meta.url).href)};
    const never = new Promise(() => {});
    const runtime = {
      ensureSession: async () => ({ id: 'synthetic-handle' }),
      startTurn: () => ({ promptStarted: Promise.resolve(), events: (async function* () { await never; })(), result: never, cancel: () => never }),
      close: async () => { throw new Error('injected release rejection'); },
      shutdown: async () => {}
    };
    const supervisor = await createSupervisor({ root: process.argv[1], stateDir: process.argv[1] + '/state', runtimeFactory: () => runtime, turnTimeoutMs: 60000, cancelGraceMs: 10, shutdownGraceMs: 10 });
    const job = await supervisor.start({ prompt: 'test' });
    await assert.rejects(supervisor.cancel(job.jobId), /cleanup/);
    assert.equal(supervisor.status(job.jobId).status, 'failed');
    await assert.rejects(supervisor.close(), /cleanup/);
    console.log('natural exit after failed cleanup');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, dir], { timeout: 5000 });
  assert.equal(result.stdout.trim(), 'natural exit after failed cleanup');
});

test('a failed canonical result stays failed even when cancellation was requested', async t => {
  const end = deferred();
  const s = await setup(t, fakeRuntime({ startTurn() { return {
    promptStarted: Promise.resolve(), events: (async function* () { await end.promise; })(),
    result: end.promise, cancel: async () => { end.resolve({ status: 'failed', error: 'backend cleanup failed' }); }
  }; } }));
  const job = await s.start({ prompt: 'test' });
  const result = await s.cancel(job.jobId);
  assert.equal(result.status, 'failed');
  assert.equal(result.result.error, 'backend cleanup failed');
});
