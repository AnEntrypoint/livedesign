const COOLDOWN_MS = 5000;
const PER_MINUTE = 6;
const GRACE_MS = 3000;
const MINUTE_MS = 60 * 1000;

function describeError(error) {
  const where = `${error.file ?? 'unknown file'}${error.line ? `:${error.line}` : ''}`;
  return `[${error.kind}] ${where} ${error.message}`.slice(0, 300);
}

export function createNoticeEngine({ send }) {
  const announced = new Set();
  const sentAt = [];
  const state = { latest: null, timer: null, announcedBroken: false, announcedUnresponsive: false };

  const canSend = () => {
    const now = Date.now();
    while (sentAt.length > 0 && now - sentAt[0] > MINUTE_MS) sentAt.shift();
    if (sentAt.length >= PER_MINUTE) return false;
    return sentAt.length === 0 || now - sentAt[sentAt.length - 1] >= COOLDOWN_MS;
  };

  const deliver = (text) => {
    if (!canSend() || !send(text)) return false;
    sentAt.push(Date.now());
    return true;
  };

  const schedule = (delay) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(evaluate, delay);
  };

  function evaluate() {
    state.timer = null;
    const snapshot = state.latest;
    if (!snapshot) return;
    const currentIds = new Set(snapshot.errors.map((error) => error.id));
    for (const id of announced) {
      if (!currentIds.has(id)) announced.delete(id);
    }
    if (snapshot.status === 'unresponsive') {
      if (!state.announcedUnresponsive) {
        const text = 'SYSTEM NOTICE (app tooling, not the user): the app page stopped responding, probably an infinite loop in code. Find and fix the loop with the edit tools; the app frame is rebuilt automatically after a fix. If you cannot find it, call restore_last_good.';
        if (deliver(text)) state.announcedUnresponsive = true;
        else schedule(COOLDOWN_MS);
      }
    } else {
      state.announcedUnresponsive = false;
    }
    const fresh = snapshot.errors.filter((error) => !error.reported && !announced.has(error.id));
    if (fresh.length > 0) {
      const text = `SYSTEM NOTICE (app tooling, not the user): the app is ${snapshot.status} with ${snapshot.errors.length} active error(s). First: ${describeError(fresh[0])}. Call read_app_log for details and fix it if it comes from a recent edit or the user's request.`;
      if (deliver(text)) {
        for (const error of fresh) announced.add(error.id);
        state.announcedBroken = true;
      } else {
        schedule(COOLDOWN_MS);
      }
    }
    if (snapshot.status === 'healthy' && state.announcedBroken) {
      if (deliver('SYSTEM NOTICE (app tooling, not the user): the app recovered and is healthy. No action needed.')) state.announcedBroken = false;
      else schedule(COOLDOWN_MS);
    }
  }

  return {
    update(snapshot) {
      state.latest = snapshot;
      if (state.timer === null) schedule(GRACE_MS);
    },
    retry() {
      schedule(0);
    },
  };
}
