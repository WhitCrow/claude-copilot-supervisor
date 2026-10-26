import test from 'node:test';
import assert from 'node:assert/strict';
import acpxPackage from 'acpx/package.json' with { type: 'json' };
import { detectRuntimeVersions } from '../scripts/runtime-versions.mjs';

test('live reports use the local copilot --version result, not a hard-coded historical version', () => {
  assert.equal(typeof detectRuntimeVersions, 'function', 'runtime version probe must exist');
  const calls = [];
  const versions = detectRuntimeVersions({ run(command, args, options) {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'GitHub Copilot CLI 9.8.7\n', stderr: '' };
  } });
  assert.deepEqual(versions.copilot, { source: 'copilot --version', version: 'GitHub Copilot CLI 9.8.7' });
  assert.equal(versions.acpx, acpxPackage.version);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'copilot');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.env.COPILOT_AUTO_UPDATE, 'false');
});

test('unavailable or failed version probes are reported unknown without inventing a version', () => {
  for (const result of [
    { error: { code: 'ENOENT' }, status: null, stdout: null },
    { error: { code: 'ETIMEDOUT' }, status: null, stdout: 'partial output' },
    { status: 1, stdout: 'not a version', stderr: 'diagnostics' },
    { status: 0, stdout: '   ' }
  ]) {
    const versions = detectRuntimeVersions({ run: () => result });
    assert.equal(versions.copilot.version, null);
    assert.equal(versions.copilot.source, 'copilot --version');
    assert.ok(versions.copilot.error);
  }
});
