const COOLDOWN_MS = 5000;
const PER_MINUTE = 6;
const PER_WINDOW = 20;
const GRACE_MS = 3000;
const MINUTE_MS = 60 * 1000;
const WINDOW_MS = 10 * MINUTE_MS;
const HEALTHY_RESET_MS = 15000;

function describeError(error) {
  const where = `${error.file ?? 'unknown file'}${error.line ? `:${error.line}` : ''}`;
  return `[${error.kind}] ${where} ${error.message}`.slice(0, 300);
}

function errorKey(error) {
  return `${error.kind}|${error.file ?? ''}|${error.line ?? ''}|${error.message}`;
}

export function createEpisode() {
  const state = { active: false, healthySince: null, counts: new Map() };

  const settle = () => {
    if (state.active && state.healthySince !== null && Date.now() - state.healthySince >= HEALTHY_RESET_MS) {
      state.active = false;
      state.counts.clear();
    }
  };

  return {
    observe({ hung, healthy }) {
      settle();
      if (hung) {
        state.active = true;
        state.healthySince = null;
      } else if (healthy) {
        state.healthySince ??= Date.now();
      } else {
        state.healthySince = null;
      }
    },
    used(name) {
      settle();
      return state.counts.get(name) ?? 0;
    },
    claim(name, limit = 1) {
      settle();
      const count = state.counts.get(name) ?? 0;
      if (!state.active || count >= limit) return false;
      state.counts.set(name, count + 1);
      return true;
    },
  };
}

export function createNoticeEngine({ send, episode }) {
  const announced = new Set();
  const sentAt = [];
  const state = { latest: null, timer: null, announcedBroken: false, healthySince: null };

  const waitBeforeSend = () => {
    const now = Date.now();
    while (sentAt.length > 0 && now - sentAt[0] > WINDOW_MS) sentAt.shift();
    const waits = [0];
    if (sentAt.length >= PER_WINDOW) waits.push(sentAt[0] + WINDOW_MS - now + 1);
    const lastMinute = sentAt.filter((time) => now - time <= MINUTE_MS);
    if (lastMinute.length >= PER_MINUTE) waits.push(lastMinute[0] + MINUTE_MS - now + 1);
    if (sentAt.length > 0) waits.push(sentAt[sentAt.length - 1] + COOLDOWN_MS - now);
    return Math.max(...waits);
  };

  const schedule = (delay) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(evaluate, delay);
  };

  const deliver = (text) => {
    const wait = waitBeforeSend();
    if (wait > 0) {
      schedule(wait);
      return false;
    }
    if (!send(text)) return false;
    sentAt.push(Date.now());
    return true;
  };

  function evaluate() {
    state.timer = null;
    const snapshot = state.latest;
    if (!snapshot) return;
    if (snapshot.status === 'unresponsive' && episode.used('unresponsive-notice') === 0) {
      const text = 'SYSTEM NOTICE (app tooling, not the user): the app page stopped responding, probably an infinite loop in code. Find and fix the loop with the edit tools; the app frame is rebuilt automatically after a fix. If you cannot find it, call restore_last_good.';
      if (deliver(text)) episode.claim('unresponsive-notice');
    }
    const fresh = snapshot.errors.filter((error) => !error.reported && !announced.has(errorKey(error)));
    if (fresh.length > 0) {
      const text = `SYSTEM NOTICE (app tooling, not the user): the app is ${snapshot.status} with ${snapshot.errors.length} active error(s). First: ${describeError(fresh[0])}. Call read_app_log for details and fix it if it comes from a recent edit or the user's request.`;
      if (deliver(text)) {
        for (const error of fresh) announced.add(errorKey(error));
        state.announcedBroken = true;
      }
    }
    if (snapshot.status === 'healthy' && state.announcedBroken) {
      if (deliver('SYSTEM NOTICE (app tooling, not the user): the app recovered and is healthy. No action needed.')) state.announcedBroken = false;
    }
  }

  return {
    update(snapshot) {
      if (snapshot.status === 'healthy') {
        state.healthySince ??= Date.now();
      } else {
        if (state.healthySince !== null && Date.now() - state.healthySince >= HEALTHY_RESET_MS) announced.clear();
        state.healthySince = null;
      }
      state.latest = snapshot;
      if (state.timer === null) schedule(GRACE_MS);
    },
    retry() {
      schedule(0);
    },
  };
}
