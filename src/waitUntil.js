// Retry helper for auto-fill. Content script, loaded before content.js (a classic script there, no
// import/export). Pure: the clock and the pause are passed in, so it is unit tested in Node.
globalThis.sftlWait = (() => {
  const found = (r) => (Array.isArray(r) ? r.length > 0 : !!r);
  const none = (r) => (Array.isArray(r) ? [] : null);

  /**
   * Runs attempt() until it finds something or the time is up. The Translate page first shows the previous
   * session's filters and another object's tree, then loads the target (dev org B-04, B-05, B-14, B-15), so
   * one search can run on a tree that is about to be replaced. While busy() (a node or the grid still
   * loading) or not ready() (the filters do not show the target yet) nothing is searched, and a hit counts
   * only if the page is still ready and not busy after the search. attempt(last) gets true on its final
   * run, so it can log a miss once. A hit on the final run counts only when ready().
   */
  async function untilFound(attempt, { timeout = 15000, busy = () => false, ready = () => true, pause, clock = Date.now, every = 500 } = {}) {
    const wait = pause || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const stop = clock() + timeout;
    for (;;) {
      while ((busy() || !ready()) && clock() < stop) await wait(200);
      const last = clock() >= stop;
      const r = await attempt(last);
      if (found(r) && ready() && (last || !busy())) return r;
      if (last) return found(r) ? none(r) : r;
      await wait(every);
    }
  }

  return { untilFound };
})();
