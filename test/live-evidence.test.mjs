import test from 'node:test';
import assert from 'node:assert/strict';
const { inspectLiveTrace } = await import('../scripts/live-evidence.mjs').catch(() => ({}));

test('live verifier reconstructs streamed text deltas instead of searching serialized JSON', () => {
  assert.equal(typeof inspectLiveTrace, 'function', 'live evidence parser must be implemented');
  const wrap = obj => ({ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const trace = [
    wrap({ jobId: 'a', sessionId: 'same', agent: 'copilot' }),
    wrap({ jobId: 'b', sessionId: 'same', agent: 'copilot' }),
    wrap({ jobId: 'c', sessionId: 'same', agent: 'copilot' }),
    wrap({ jobId: 'c', sessionId: 'same', status: 'completed', events: [{ type: 'text_delta', text: 'TWO_' }, { type: 'text_delta', text: 'REAL_AGENTS_' }, { type: 'text_delta', text: '739' }] })
  ];
  const result = inspectLiveTrace(trace);
  assert.equal(result.continuity, true);
  assert.equal(result.realCopilot, true);
  assert.equal(result.sameSession, true);
  assert.equal(result.followupOutput, 'TWO_REAL_AGENTS_739');
  trace[1] = wrap({ jobId: 'b', sessionId: 'other', agent: 'copilot' });
  assert.equal(inspectLiveTrace(trace).sameSession, false);
});
