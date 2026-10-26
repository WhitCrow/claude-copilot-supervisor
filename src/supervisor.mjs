import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from 'acpx/runtime';
import { ApprovalQueue } from './approval.mjs';

async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Runtime is real acpx; only agentArgv can select the explicit test fixture. */
export async function createSupervisor({ root, stateDir, agentArgv, approvalTimeoutMs = 60_000, turnTimeoutMs = 300_000, cancelGraceMs = 3000, shutdownGraceMs = 3000, maxSessions = 4, maxJobs = 64, runtimeFactory = createAcpRuntime }) {
  root = await realpath(root);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const queue = new ApprovalQueue({ timeoutMs: approvalTimeoutMs });
  const agent = agentArgv ? 'supervisor-fixture' : 'copilot';
  const processes = new Map();
  let closing = false;
  let preparingSessions = 0;
  const runtime = runtimeFactory({
    cwd: root,
    sessionStore: createFileSessionStore({ stateDir }),
    agentRegistry: createAgentRegistry({ overrides: agentArgv ? { [agent]: agentArgv } : {
      copilot: ['copilot', '--acp', '--stdio', '--disable-builtin-mcps', '--no-custom-instructions', '--available-tools=view,create,edit,apply_patch,bash']
    } }),
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny',
    permissionPolicy: { defaultAction: 'deny' },
    fs: false, terminal: false,
    agentProcessEnvAllow: ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'],
    agentProcessEnv: { COPILOT_ALLOW_ALL: 'false', COPILOT_AUTO_UPDATE: 'false' },
    processLifecycle: {
      onBeforeSpawn() { if (closing) throw new Error('Supervisor closed'); },
      onSpawned(info) { processes.set(info.launchId, info); if (closing) throw new Error('Supervisor closed'); },
      onExit(info) { processes.delete(info.launchId); }
    },
    // Startup/handshake has its own budget; per-turn timeout is passed below.
    timeoutMs: 10_000
  });
  const sessions = new Map();
  const jobs = new Map();
  const admissions = new Set();
  let closePromise;
  const forceStop = sessionId => {
    const errors = [];
    for (const info of processes.values()) {
      if (sessionId && (info.scope.kind !== 'runtime-session' || info.scope.sessionKey !== sessionId)) continue;
      try { process.kill(info.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned process force-stop failed');
  };
  const get = id => { const job = jobs.get(id); if (!job) throw new Error('Unknown job'); return job; };
  function status(jobId) {
    const job = get(jobId);
    const approvals = queue.list(jobId);
    return structuredClone({ jobId, sessionId: job.sessionId, status: job.status === 'running' && approvals.length ? 'waiting_approval' : job.status, approvals, events: job.events, result: job.result });
  }
  function start(input) {
    if (closing) return Promise.reject(new Error('Supervisor closed'));
    const pending = admit(input);
    admissions.add(pending);
    void pending.then(() => admissions.delete(pending), () => admissions.delete(pending));
    return pending;
  }
  async function admit({ prompt, sessionId, signal }) {
    if (closing) throw new Error('Supervisor closed');
    signal?.throwIfAborted();
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32_000) throw new Error('Prompt must contain 1..32000 characters');
    let session;
    if (sessionId) { session = sessions.get(sessionId); if (!session || session.closing) throw new Error('Unknown or closing session'); }
    else {
      if (sessions.size + preparingSessions >= maxSessions) throw new Error('Session limit reached; close a session first');
      sessionId = randomUUID();
      let handle;
      preparingSessions++;
      try { handle = await runtime.ensureSession({ sessionKey: sessionId, agent, mode: 'persistent', cwd: root }); }
      finally { preparingSessions--; }
      if (closing || signal?.aborted) {
        await runtime.close({ handle, reason: 'Start admission revoked' });
        if (closing) throw new Error('Supervisor closed during start');
        signal.throwIfAborted();
      }
      session = { handle }; sessions.set(sessionId, session);
    }
    if ([...jobs.values()].some(j => j.sessionId === sessionId && j.status === 'running')) throw new Error('Session already has an active turn');
    while (jobs.size >= maxJobs) {
      const retired = [...jobs.values()].find(j => j.status !== 'running');
      if (!retired) throw new Error('Job limit reached');
      jobs.delete(retired.jobId);
    }
    const jobId = randomUUID();
    const controller = new AbortController();
    const job = { jobId, sessionId, controller, status: 'running', events: [], result: null, timedOut: false };
    jobs.set(jobId, job);
    // The host owns the deadline. A late end_turn must not turn timeout into success.
    const deadline = setTimeout(() => {
      job.timedOut = true;
      controller.abort(new Error('Turn deadline exceeded'));
    }, turnTimeoutMs);
    let turn;
    try { turn = runtime.startTurn({
      handle: session.handle, text: prompt, mode: 'prompt', requestId: jobId,
      signal: controller.signal, timeoutMs: turnTimeoutMs + 1000,
      onPermissionRequest: (request, { signal }) => queue.request({ jobId, request, signal: AbortSignal.any([signal, controller.signal]) })
    }); } catch (error) {
      clearTimeout(deadline);
      controller.abort();
      jobs.delete(jobId);
      try { await within(runtime.close({ handle: session.handle, reason: 'Backend start failed' }), shutdownGraceMs, 'Failed-start cleanup'); }
      finally { sessions.delete(sessionId); }
      throw error;
    }
    job.deadline = deadline;
    job.turn = turn;
    void turn.promptStarted.catch(() => {});
    void turn.result.catch(() => {});
    job.done = (async () => {
      try {
        for await (const event of turn.events) {
          if (job.forcedStop) break;
          if (event.type === 'text_delta' && event.stream === 'thought') continue;
          // Local bounded operational output, not a hidden-reasoning transcript.
          if (event.type === 'text_delta') job.events.push({ type: event.type, text: event.text.slice(0, 8000) });
          else if (['done', 'error', 'status'].includes(event.type)) job.events.push(event);
          if (job.events.length > 100) job.events.shift();
        }
        const backendResult = await turn.result;
        if (job.forcedStop) return;
        job.status = job.timedOut || job.forcedStop || backendResult.status === 'failed' ? 'failed' : controller.signal.aborted ? 'cancelled' : backendResult.status;
        job.result = job.timedOut || job.forcedStop ? { status: 'failed', error: job.forcedStop ? 'Cancellation grace exceeded; connection closed' : 'Turn deadline exceeded', backendResult } : backendResult;
      } catch (error) {
        if (job.forcedStop) return;
        job.status = !job.timedOut && controller.signal.aborted && error.name === 'AbortError' ? 'cancelled' : 'failed';
        job.result = { status: job.status, error: job.timedOut ? 'Turn deadline exceeded' : error.message };
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
    })();
    return { jobId, sessionId, status: 'running', agent: agentArgv ? 'TEST_FIXTURE_NOT_COPILOT' : 'copilot' };
  }
  async function cancel(jobId) {
    const job = get(jobId);
    if (job.status !== 'running') return status(jobId);
    job.controller.abort();
    try {
      await within(Promise.all([job.turn?.cancel(), job.done]), cancelGraceMs, 'Cancellation');
    } catch (error) {
      job.forcedStop = true;
      clearTimeout(job.deadline);
      job.status = 'failed';
      job.result = { status: 'failed', error: 'Cancellation cleanup required connection close', cancellationError: error.message, cleanupErrors: [] };
      const session = sessions.get(job.sessionId);
      if (session) session.closing = true;
      const errors = [error];
      try {
        if (session) {
          await within(runtime.close({ handle: session.handle, reason: 'Forced cancellation' }), shutdownGraceMs, 'Connection close');
          sessions.delete(job.sessionId);
        }
      } catch (closeError) {
        errors.push(closeError);
        try { forceStop(job.sessionId); } catch (stopError) { errors.push(stopError); }
      }
      try { await within(job.done, shutdownGraceMs, 'Cancelled task drain'); }
      catch (drainError) { errors.push(drainError); }
      job.result.cleanupErrors = errors.slice(1).map(error => error.message);
      if (errors.length > 1) throw new AggregateError(errors, 'Cancellation cleanup failed');
    }
    return status(jobId);
  }
  async function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Unknown session');
    session.closing = true;
    for (const job of jobs.values()) if (job.sessionId === sessionId && job.status === 'running') await cancel(job.jobId);
    if (sessions.has(sessionId)) await within(runtime.close({ handle: session.handle, reason: 'Session explicitly closed' }), shutdownGraceMs, 'Session close');
    sessions.delete(sessionId);
    return { sessionId, closed: true };
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const errors = [];
      try { await within(Promise.allSettled([...admissions]), shutdownGraceMs, 'Start admission cleanup'); }
      catch (error) { errors.push(error); try { forceStop(); } catch (stopError) { errors.push(stopError); } }
      const cancelled = await Promise.allSettled([...jobs.values()].filter(j => j.status === 'running').map(j => cancel(j.jobId)));
      errors.push(...cancelled.filter(x => x.status === 'rejected').map(x => x.reason));
      const released = await Promise.allSettled([...sessions.entries()].map(async ([sessionId, session]) => {
        session.closing = true;
        await within(runtime.close({ handle: session.handle, reason: 'Supervisor shutdown' }), shutdownGraceMs, 'Session cleanup');
        sessions.delete(sessionId);
      }));
      errors.push(...released.filter(x => x.status === 'rejected').map(x => x.reason));
      try { await within(Promise.resolve(runtime.shutdown?.()), shutdownGraceMs, 'Runtime shutdown'); }
      catch (error) { errors.push(error); try { forceStop(); } catch (stopError) { errors.push(stopError); } }
      if (errors.length) throw new AggregateError(errors, 'Supervisor cleanup failed');
    })();
    return closePromise;
  }
  return { start, status, decide: input => queue.decide(input), cancel, closeSession, close };
}
