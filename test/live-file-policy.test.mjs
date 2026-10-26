import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { isSafeProbeWrite } from '../scripts/live-file-policy.mjs';
const root = path.resolve(path.sep, 'synthetic-project');
const target = path.join(root, 'approved-real.txt');
const marker = 'COPILOT_REAL_APPROVED';
function request() {
  return {
    toolCallId: 'synthetic-call', title: 'Create approved-real.txt', kind: 'edit',
    rawInput: { fileName: target },
    locations: [{ path: target }],
    content: [{ type: 'diff', path: target, oldText: '', newText: marker + '\n' }]
  };
}

test('probe approves only a structured single-file create, not a matching outside basename', () => {
  assert.equal(typeof isSafeProbeWrite, 'function', 'pure fail-closed probe policy must be implemented');
  assert.equal(isSafeProbeWrite(request(), { root, fileExists: false }), true);
  const outside = request();
  outside.rawInput.fileName = path.resolve('outside', 'approved-real.txt');
  outside.locations[0].path = outside.rawInput.fileName;
  outside.content[0].path = outside.rawInput.fileName;
  assert.equal(isSafeProbeWrite(outside, { root, fileExists: false }), false);
});

test('probe accepts only the fixed text with at most a trailing newline and one blank line', () => {
  for (const suffix of ['', '\n', '\n\n']) {
    for (const oldText of ['', null]) {
      const call = request(); call.content[0].newText = marker + suffix; call.content[0].oldText = oldText;
      assert.equal(isSafeProbeWrite(call, { root, fileExists: false }), true);
    }
  }
  assert.equal(isSafeProbeWrite(request(), { root, fileExists: true }), false);
  assert.equal(isSafeProbeWrite(request(), { root }), false);
});

const mutations = {
  'outside rawInput with expected diff': call => { call.rawInput.fileName = path.resolve(path.sep, 'outside', 'approved-real.txt'); },
  'relative target': call => { call.rawInput.fileName = 'approved-real.txt'; },
  'traversal target': call => { call.rawInput.fileName = root + '/../approved-real.txt'; },
  'suffix target': call => { call.rawInput.fileName += '.other'; },
  'extra raw target': call => { call.rawInput.otherFile = target; },
  'raw shell command': call => { call.rawInput.command = 'echo COPILOT_REAL_APPROVED'; },
  'raw content mismatch': call => { call.rawInput.content = marker + '\ncommand'; },
  'rawInput serialized JSON': call => { call.rawInput = JSON.stringify(call.rawInput); },
  'rawInput array': call => { call.rawInput = [call.rawInput]; },
  'missing rawInput': call => { delete call.rawInput; },
  'missing raw target': call => { delete call.rawInput.fileName; },
  'different location': call => { call.locations[0].path = path.join(root, 'other.txt'); },
  'extra outside location': call => { call.locations.push({ path: path.resolve(path.sep, 'outside', 'approved-real.txt') }); },
  'empty locations': call => { call.locations = []; },
  'missing locations': call => { delete call.locations; },
  'ambiguous location': call => { call.locations[0].fileName = target; },
  'unknown location shape': call => { call.locations = [target]; },
  'different diff target': call => { call.content[0].path = path.join(root, 'other.txt'); },
  'extra diff target': call => { call.content.push({ ...call.content[0], path: path.join(root, 'other.txt') }); },
  'duplicate diff': call => { call.content.push({ ...call.content[0] }); },
  'shell content': call => { call.content.push({ type: 'content', content: { type: 'text', text: 'run command' } }); },
  'extra terminal content': call => { call.content.push({ type: 'terminal', terminalId: 'synthetic-terminal' }); },
  'deletion': call => { call.content[0].newText = ''; },
  'replacement': call => { call.content[0].oldText = 'existing content'; },
  'missing oldText': call => { delete call.content[0].oldText; },
  'extra diff operation': call => { call.content[0].command = 'echo command'; },
  'unknown diff kind': call => { call.content[0].type = 'patch'; },
  'extra text command': call => { call.content[0].newText += 'echo command\n'; },
  'extra blank lines': call => { call.content[0].newText = marker + '\n\n\n'; },
  'leading whitespace': call => { call.content[0].newText = ' ' + marker; },
  'trailing whitespace': call => { call.content[0].newText = marker + ' '; },
  'text contains marker': call => { call.content[0].newText = 'prefix ' + marker; },
  'execute kind': call => { call.kind = 'execute'; },
  'missing content': call => { delete call.content; },
  'empty content': call => { call.content = []; },
  'unknown top-level operation': call => { call.command = 'echo command'; }
};
for (const [label, mutate] of Object.entries(mutations)) {
  test(`probe denies ${label}`, () => {
    const call = request(); mutate(call);
    assert.equal(isSafeProbeWrite(call, { root, fileExists: false }), false);
  });
}
function nativeRequest() {
  const call = request();
  delete call.content;
  call.rawInput.diff = `\ndiff --git a${target} b${target}\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b${target}\n@@ -1,0 +1,2 @@\n+${marker}\n+\n\n`;
  return call;
}
test('probe accepts the observed Copilot rawInput unified create diff', () => {
  assert.equal(isSafeProbeWrite(nativeRequest(), { root, fileExists: false }), true);
});
for (const [label, mutate] of Object.entries({
  'extra file': call => { call.rawInput.diff += `diff --git a${target}.other b${target}.other\n`; },
  'outside header': call => { call.rawInput.diff = call.rawInput.diff.replace(`a${target}`, 'a/outside/approved-real.txt'); },
  'outside destination': call => { call.rawInput.diff = call.rawInput.diff.replace(`+++ b${target}`, '+++ b/outside/approved-real.txt'); },
  'unexpected deletion': call => { call.rawInput.diff = call.rawInput.diff.replace('+COPILOT', '-COPILOT'); },
  'extra shell command': call => { call.rawInput.command = 'echo command'; },
  'extra diff command': call => { call.rawInput.diff += 'echo command\n'; },
  'wrong hunk size': call => { call.rawInput.diff = call.rawInput.diff.replace('+1,2', '+1,3'); },
  'executable mode': call => { call.rawInput.diff = call.rawInput.diff.replace('100644', '100755'); },
  'existing source': call => { call.rawInput.diff = call.rawInput.diff.replace('a/dev/null', `a${target}`); },
  'ambiguous second representation': call => { call.content = request().content; },
  'extra raw content': call => { call.rawInput.content = marker; },
  'different location': call => { call.locations[0].path += '.other'; },
  'extra outside location': call => { call.locations.push({ path: '/outside/approved-real.txt' }); },
  'outside fileName': call => { call.rawInput.fileName = '/outside/approved-real.txt'; }
})) {
  test(`probe native diff denies ${label}`, () => {
    const call = nativeRequest(); mutate(call);
    assert.equal(isSafeProbeWrite(call, { root, fileExists: false }), false);
  });
}
test('probe denies null, primitive and other unknown request shapes', () => {
  for (const call of [null, undefined, [], 'approved-real.txt COPILOT_REAL_APPROVED', 42, {}]) {
    assert.equal(isSafeProbeWrite(call, { root, fileExists: false }), false);
  }
});
