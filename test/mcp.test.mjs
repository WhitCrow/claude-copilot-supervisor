import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const base = tmpdir();
const delay = ms => new Promise(r => setTimeout(r, ms));

test('MCP disconnect revokes outstanding approval before process exit', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(base, 'supervisor-disconnect-test-'));
  const root = path.join(dir, 'project'); await mkdir(root);
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--project-root', root, '--state-dir', path.join(dir, 'state'), '--fixture'], stderr: 'pipe' });
  const client = new Client({ name: 'disconnect-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const job = await call('copilot_start', { prompt: JSON.stringify({ action: 'write', file: 'disconnect.txt', content: 'never' }) });
  let waiting;
  for (let n = 0; n < 100; n++) { waiting = await call('copilot_status', { jobId: job.jobId }); if (waiting.approvals.length) break; await delay(20); }
  assert.equal(waiting.approvals.length, 1);
  const pid = transport.pid;
  await client.close();
  await delay(100);
  await assert.rejects(access(path.join(root, 'disconnect.txt')));
  if (pid) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('MCP start cancellation during preparation does not consume a session slot', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(base, 'supervisor-request-cancel-'));
  const root = path.join(dir, 'project'); await mkdir(root);
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--project-root', root, '--state-dir', path.join(dir, 'state'), '--fixture'], stderr: 'pipe' });
  const client = new Client({ name: 'cancel-request-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  for (let n = 0; n < 5; n++) {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'copilot_start', arguments: { prompt: '{"action":"echo","message":"cancelled admission"}' } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await delay(25); controller.abort(); await rejected;
    await delay(650);
  }
  const result = await client.callTool({ name: 'copilot_start', arguments: { prompt: '{"action":"echo","message":"admitted after cancellations"}' } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
});

test('MCP child process exposes nonblocking start, read status and one-time decisions', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(base, 'supervisor-mcp-test-'));
  const root = path.join(dir, 'project'); await mkdir(root);
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--project-root', root, '--state-dir', path.join(dir, 'state'), '--fixture'], stderr: 'pipe' });
  const client = new Client({ name: 'supervisor-test-controller', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(x => x.name);
  assert.deepEqual(names.sort(), ['copilot_cancel', 'copilot_close_session', 'copilot_decide', 'copilot_start', 'copilot_status']);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const job = await call('copilot_start', { prompt: JSON.stringify({ action: 'write', file: 'mcp-approved.txt', content: 'MCP writes after approval' }) });
  assert.equal(job.agent, 'TEST_FIXTURE_NOT_COPILOT');
  const waiting = await call('copilot_status', { jobId: job.jobId, waitMs: 10000 });
  assert.equal(waiting.status, 'waiting_approval');
  await assert.rejects(access(path.join(root, 'mcp-approved.txt')));
  await call('copilot_decide', { jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' });
  let done;
  for (let n = 0; n < 100; n++) {
    done = await call('copilot_status', { jobId: job.jobId });
    if (done.status === 'completed') break;
    await delay(20);
  }
  assert.equal(done.status, 'completed');
  assert.equal(await readFile(path.join(root, 'mcp-approved.txt'), 'utf8'), 'MCP writes after approval');
  const replay = await client.callTool({ name: 'copilot_decide', arguments: { jobId: job.jobId, approvalId: waiting.approvals[0].id, decision: 'approve' } });
  assert.equal(replay.isError, true);
  const closed = await call('copilot_close_session', { sessionId: job.sessionId });
  assert.equal(closed.closed, true);
  const staleSession = await client.callTool({ name: 'copilot_start', arguments: { sessionId: job.sessionId, prompt: '{"action":"echo","message":"invalid"}' } });
  assert.equal(staleSession.isError, true);
});
