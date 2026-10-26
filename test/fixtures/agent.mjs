import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

// DETERMINISTIC TEST AGENT, NOT COPILOT. Only known probe actions are supported.
const sessions = new Map();
const pending = new Map();
const active = new Map();
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const ask = (method, params) => new Promise(resolve => {
  const id = randomUUID(); pending.set(id, resolve); send({ id, method, params });
});
const notify = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
async function handle(m) {
  if (!m.method) { pending.get(m.id)?.(m.result ?? { outcome: { outcome: 'cancelled' } }); pending.delete(m.id); return; }
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: 1, agentInfo: { name: 'deterministic-test-agent', version: '1.0.0' }, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [] });
  if (m.method === 'session/new') {
    const sessionId = randomUUID(); sessions.set(sessionId, { cwd: m.params.cwd, turns: 0 });
    return reply(m.id, { sessionId });
  }
  if (m.method === 'session/load') {
    if (!sessions.has(m.params.sessionId)) sessions.set(m.params.sessionId, { cwd: m.params.cwd, turns: 0 });
    return reply(m.id, {});
  }
  if (m.method === 'session/cancel') {
    active.get(m.params.sessionId)?.abort();
    for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } });
    pending.clear(); return;
  }
  if (m.method === 'session/prompt') {
    const { sessionId } = m.params;
    const session = sessions.get(sessionId);
    const controller = new AbortController(); active.set(sessionId, controller);
    const task = JSON.parse(m.params.prompt.filter(x => x.type === 'text').map(x => x.text).join(''));
    session.turns++;
    if (task.action === 'echo') {
      notify(sessionId, JSON.stringify({ fixture: true, sessionId, turns: session.turns, message: task.message }));
      active.delete(sessionId); return reply(m.id, { stopReason: 'end_turn' });
    }
    const target = path.resolve(session.cwd, task.file);
    if (!target.startsWith(session.cwd + path.sep)) throw new Error('Fixture path outside root');
    const command = task.action === 'command';
    const toolCall = { toolCallId: randomUUID(), title: command ? 'Run deterministic Node probe' : 'Edit fixture probe', kind: command ? 'execute' : 'edit', rawInput: { path: target, content: task.content }, content: [], locations: [{ path: target }] };
    const answer = await ask('session/request_permission', {
      sessionId, toolCall,
      options: [
        ...(task.alwaysOnly ? [] : [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }]),
        { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' },
        { optionId: 'deny-once', kind: 'reject_once', name: 'Reject once' }
      ]
    });
    const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow-once' && !controller.signal.aborted;
    if (allowed) {
      if (command) await promisify(execFile)(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", target, task.content], { timeout: 2000, signal: controller.signal });
      else await writeFile(target, task.content, { mode: 0o600 });
    }
    notify(sessionId, JSON.stringify({ fixture: true, allowed, action: task.action, sessionId, turns: session.turns }));
    active.delete(sessionId);
    return reply(m.id, { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' });
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message).catch(error => { if (message.id !== undefined) send({ id: message.id, error: { code: -32603, message: error.message } }); });
});
