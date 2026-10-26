import { randomUUID } from 'node:crypto';

/** In-memory requests only; never silently upgrades allow_once to allow_always. */
export class ApprovalQueue {
  constructor({ timeoutMs = 60_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }
  request({ jobId, request, signal }) {
    if (signal?.aborted) return Promise.resolve({ outcome: 'cancel' });
    const id = randomUUID();
    const snapshot = structuredClone(request);
    return new Promise(resolve => {
      const item = { id, jobId, request: snapshot, resolve, expiresAt: performance.now() + this.timeoutMs };
      item.finish = result => {
        if (!this.pending.delete(id)) return;
        clearTimeout(item.timer);
        signal?.removeEventListener('abort', item.abort);
        resolve(result);
      };
      item.abort = () => item.finish({ outcome: 'cancel' });
      this.pending.set(id, item);
      item.timer = setTimeout(item.abort, this.timeoutMs);
      signal?.addEventListener('abort', item.abort, { once: true });
      if (signal?.aborted) item.abort();
    });
  }
  list(jobId) {
    for (const item of this.pending.values()) if (performance.now() >= item.expiresAt) item.abort();
    return [...this.pending.values()].filter(x => x.jobId === jobId).map(x => ({
      id: x.id, jobId: x.jobId, toolCall: structuredClone(x.request.raw.toolCall),
      options: structuredClone(x.request.raw.options)
    }));
  }
  decide({ jobId, approvalId, decision }) {
    if (!['approve', 'deny'].includes(decision)) throw new Error('Invalid decision');
    const item = this.pending.get(approvalId);
    if (!item || item.jobId !== jobId) throw new Error('Unknown or expired approval');
    if (performance.now() >= item.expiresAt) {
      item.abort();
      throw new Error('Unknown or expired approval');
    }
    const kind = decision === 'approve' ? 'allow_once' : 'reject_once';
    const option = item.request.raw.options.find(x => x.kind === kind);
    if (!option && decision === 'approve') throw new Error('No one-time approval option');
    item.finish(option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancel' });
    return { approvalId, decision };
  }
}
