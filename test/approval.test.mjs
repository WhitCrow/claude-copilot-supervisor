import test from 'node:test';
import assert from 'node:assert/strict';

const { ApprovalQueue } = await import('../src/approval.mjs').catch(() => ({}));
const request = () => ({ sessionId: 'session-a', inferredKind: 'edit', raw: {
  sessionId: 'session-a', toolCall: { toolCallId: 'tool-a', title: 'Edit probe.txt', kind: 'edit', rawInput: { path: 'probe.txt', content: 'approved' } },
  options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }]
} });

test('holds the exact permission request until an explicit one-time decision', async () => {
  assert.equal(typeof ApprovalQueue, 'function', 'ApprovalQueue must be implemented');
  const queue = new ApprovalQueue({ timeoutMs: 2000 });
  let settled = false;
  const pending = queue.request({ jobId: 'job-a', request: request() }).then(x => { settled = true; return x; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false);
  const [item] = queue.list('job-a');
  assert.equal(item.toolCall.rawInput.path, 'probe.txt');
  queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'approve' });
  assert.deepEqual(await pending, { outcome: 'selected', optionId: 'once' });
  assert.deepEqual(queue.list('job-a'), []);
});

test('cannot approve an expired request even while the event loop delays its timer', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 15 });
  const pending = queue.request({ jobId: 'job-a', request: request() });
  const [item] = queue.list('job-a');
  const until = performance.now() + 45;
  while (performance.now() < until) { /* deliberately delay timer dispatch */ }
  try {
    assert.throws(() => queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'approve' }), /expired/);
    assert.deepEqual(await pending, { outcome: 'cancel' });
  } finally { if (queue.list('job-a').length) queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'deny' }); }
});

test('expires without approval and rejects a late decision', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 25 });
  const pending = queue.request({ jobId: 'job-a', request: request() });
  const [item] = queue.list('job-a');
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))]);
  assert.deepEqual(result, { outcome: 'cancel' });
  assert.throws(() => queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'approve' }), /expired/);
});

test('rejects invalid decisions without consuming the request', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 1000 });
  const pending = queue.request({ jobId: 'job-a', request: request() });
  const [item] = queue.list('job-a');
  try {
    assert.throws(() => queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'yes-forever' }), /Invalid decision/);
    assert.equal(queue.list('job-a').length, 1);
  } finally { if (queue.list('job-a').length) queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'deny' }); await pending; }
});

test('binds requests to jobs and consumes each decision only once', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 1000 });
  const pending = queue.request({ jobId: 'job-a', request: request() });
  const [item] = queue.list('job-a');
  assert.throws(() => queue.decide({ jobId: 'job-b', approvalId: item.id, decision: 'approve' }), /expired/);
  queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'deny' });
  assert.deepEqual(await pending, { outcome: 'selected', optionId: 'no' });
  assert.throws(() => queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'approve' }), /expired/);
});

test('never substitutes permanent approval for a missing one-time option', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 1000 });
  const input = request(); input.raw.options = input.raw.options.filter(x => x.kind !== 'allow_once');
  const pending = queue.request({ jobId: 'job-a', request: input });
  const [item] = queue.list('job-a');
  assert.throws(() => queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'approve' }), /one-time/);
  queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'deny' });
  await pending;
});

test('snapshots execution details rather than trusting mutable caller data', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 1000 });
  const input = request(); const pending = queue.request({ jobId: 'job-a', request: input });
  input.raw.toolCall.rawInput.path = 'changed';
  const [item] = queue.list('job-a'); item.toolCall.rawInput.path = 'also-changed';
  assert.equal(queue.list('job-a')[0].toolCall.rawInput.path, 'probe.txt');
  queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'deny' }); await pending;
});

test('abort revokes permission and prevents late approval', async () => {
  const queue = new ApprovalQueue({ timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = queue.request({ jobId: 'job-a', request: request(), signal: controller.signal });
  const [item] = queue.list('job-a');
  controller.abort();
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))]);
  assert.deepEqual(result, { outcome: 'cancel' });
  assert.throws(() => queue.decide({ jobId: 'job-a', approvalId: item.id, decision: 'approve' }), /expired/);
});
