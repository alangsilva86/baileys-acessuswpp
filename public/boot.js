const app = window.dashboardApp;
if (!app) {
  throw new Error('dashboardApp não inicializado.');
}

const {
  refreshInstances,
  refreshSelected,
  refreshLogs,
  state,
  REFRESH_INTERVAL_MS,
} = app;

state.telemetry = state.telemetry || {
  lastRoundStartedAt: null,
  lastRoundCompletedAt: null,
  lastRoundDurationMs: null,
};
state.scheduler = state.scheduler || {
  currentTimer: null,
  currentController: null,
  runningPromise: null,
};

const telemetry = state.telemetry;
const schedulerState = state.scheduler;

function clearScheduledRound() {
  if (schedulerState.currentTimer) {
    clearTimeout(schedulerState.currentTimer);
    schedulerState.currentTimer = null;
  }
}

function scheduleNextRound(delay = REFRESH_INTERVAL_MS) {
  clearScheduledRound();
  schedulerState.currentTimer = setTimeout(() => {
    schedulerState.currentTimer = null;
    startRound({ reason: 'auto' }).catch((err) => {
      if (err?.name === 'AbortError') return;
      console.debug('[dashboard] rodada automática falhou', err);
    });
  }, delay);
}

function updateTelemetry(startedAt) {
  const completedAt = Date.now();
  telemetry.lastRoundCompletedAt = completedAt;
  telemetry.lastRoundDurationMs = completedAt - startedAt;
}

async function runRoundSequence(options, controller) {
  const silent = options.silent;
  const withSkeleton = options.withSkeleton;

  await refreshInstances({ silent, withSkeleton, signal: controller.signal });
  if (controller.signal.aborted) return;

  await refreshSelected({ silent, withSkeleton, signal: controller.signal });
  if (controller.signal.aborted) return;

  await refreshLogs({ silent: true, signal: controller.signal });
}

function startRound(options = {}) {
  const reason = options.reason || 'auto';
  const hasRunning = schedulerState.runningPromise && !schedulerState.currentController?.signal?.aborted;
  if (hasRunning) {
    return schedulerState.runningPromise;
  }

  clearScheduledRound();

  const controller = new AbortController();
  schedulerState.currentController = controller;

  const silent = options.silent ?? (reason === 'auto');
  const withSkeleton = options.withSkeleton ?? (reason !== 'auto');

  const startedAt = Date.now();
  telemetry.lastRoundStartedAt = startedAt;

  const roundPromise = (async () => {
    try {
      await runRoundSequence({ silent, withSkeleton }, controller);
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        return;
      }
      console.debug('[dashboard] erro na rodada de atualização', err);
    } finally {
      updateTelemetry(startedAt);
      if (schedulerState.currentController === controller) {
        schedulerState.runningPromise = null;
        if (!controller.signal.aborted) {
          scheduleNextRound(REFRESH_INTERVAL_MS);
        }
      }
    }
  })();

  schedulerState.runningPromise = roundPromise;
  return roundPromise;
}

function requestImmediateRound(options = {}) {
  schedulerState.currentController?.abort();
  schedulerState.currentController = null;
  schedulerState.runningPromise = null;
  clearScheduledRound();
  const merged = {
    reason: options.reason || 'manual',
    silent: options.silent,
    withSkeleton: options.withSkeleton,
  };
  return startRound(merged);
}

function cancelInFlight() {
  schedulerState.currentController?.abort();
  schedulerState.currentController = null;
  clearScheduledRound();
}

window.dashboardAppScheduler = {
  requestImmediateRound,
  scheduleNextRound,
  cancelInFlight,
};

requestImmediateRound({ reason: 'initial', silent: false, withSkeleton: true }).catch((err) => {
  if (err?.name === 'AbortError') return;
  console.debug('[dashboard] rodada inicial falhou', err);
});
