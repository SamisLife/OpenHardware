/* ============================================================================
   gate.js — the one place a human is asked before something irreversible.
   ----------------------------------------------------------------------------
   Agent tools ask here before they write firmware or credentials to the board.
   Keeping the decision in one place fixes the property that matters: there is
   exactly one pending gate, and Approve means whatever is pending.

   Approve and Hold are never tools. An agent that could approve its own gate
   has no gate, and the entire reason this exists is that a model does not get
   to decide, on its own, to flash a board or to write something that outlives
   the session.

   `held` is a resolution and the calling tool treats it as "no". This file
   only reports what the human did.
   ========================================================================== */

/** The gate currently waiting on a person, or null. */
let pending = null;

export function pendingGate() { return pending; }

/**
 * Ask, and wait for the answer.
 *
 * @param {object} req
 *   action      what is about to happen, as a sentence the operator sees
 *   rationale   why it needs a person
 *   policy      what happens if nobody answers, as shown beside the buttons
 *   timeoutMs   auto-approve after this long, or null to wait indefinitely
 *   signal      an AbortSignal; aborting resolves 'cancelled'
 *   onState     called with 'pending', then with the resolution
 * @returns {Promise<'operator'|'held'|'policy'|'cancelled'>}
 */
export function requestGate({ action, rationale, policy, timeoutMs = null, signal = null, onState } = {}) {
  if (pending) {
    /* Refused rather than queued. Two pending gates would mean the buttons
       answer one of them and the operator cannot tell which. */
    return Promise.reject(new Error(`a gate is already waiting: ${pending.action}`));
  }

  return new Promise(resolve => {
    let done = false;
    let timer = 0;

    const finish = who => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      pending = null;
      onState?.(who);
      resolve(who);
    };
    const onAbort = () => finish('cancelled');

    if (signal?.aborted) return finish('cancelled');
    signal?.addEventListener?.('abort', onAbort);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish('policy'), timeoutMs);
    }

    pending = {
      action, rationale, policy,
      requestedAt: Date.now(),
      approve: () => finish('operator'),
      hold: () => finish('held'),
      cancel: () => finish('cancelled'),
    };
    onState?.('pending');
  });
}

/** The buttons. Each answers whatever is pending, and is a no-op otherwise. */
export function approvePending() { pending?.approve(); }
export function holdPending() { pending?.hold(); }
export function cancelPending() { pending?.cancel(); }
