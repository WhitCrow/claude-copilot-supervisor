/** Parse recorded MCP payloads, not a model's final narrative or JSON substring. */
export function inspectLiveTrace(trace) {
  const payloads = [];
  for (const entry of trace) {
    if (entry.type !== 'tool_result' || entry.is_error) continue;
    for (const block of Array.isArray(entry.content) ? entry.content : []) {
      if (block.type !== 'text') continue;
      try { payloads.push(JSON.parse(block.text)); } catch { /* not structured MCP data */ }
    }
  }
  const starts = payloads.filter(x => typeof x.agent === 'string' && x.jobId && x.sessionId);
  const last = starts.at(-1);
  const finalStatus = payloads.findLast(x => x.jobId === last?.jobId && x.status === 'completed' && Array.isArray(x.events));
  const followupOutput = (finalStatus?.events || []).filter(x => x.type === 'text_delta').map(x => x.text).join('');
  return {
    realCopilot: starts.length === 3 && starts.every(x => x.agent === 'copilot'),
    sameSession: starts.length === 3 && new Set(starts.map(x => x.sessionId)).size === 1,
    continuity: followupOutput.trim() === 'TWO_REAL_AGENTS_739',
    followupOutput,
    startedJobs: starts.length
  };
}
