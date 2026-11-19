// Retry helper for auto-fill. Content script, loaded before content.js (a classic script there, no
// import/export). Pure: the clock and the pause are passed in, so it is unit tested in Node.
globalThis.sftlWait = (() => {
  const found = (r) => (Array.isArray(r) ? r.length > 0 : !!r);

  /**
   * Runs attempt() until it finds something or the time is up. The Translate page first shows the previous
   * session's filters and another object's tree, then loads the target (dev org B-04, B-05, B-14, B-15), so
   * one search can run on a tree that is about to be replaced. While busy() (a node or the grid still
   * loading) nothing is searched. attempt(last) gets true on its final run, so it can log a miss once.
   */
  async function untilFound(attempt, { timeout = 15000, busy = () => false, pause, clock = Date.now, every = 500 } = {}) {
    const wait = pause || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const stop = clock() + timeout;
    for (;;) {
      while (busy() && clock() < stop) await wait(200);
      const last = clock() >= stop;
      const r = await attempt(last);
      if (found(r) || last) return r;
      await wait(every);
    }
  }

  return { untilFound };
})();
