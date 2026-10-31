// Waiting that a signal can cut short. `sleep` is the real timer, cleared on abort so an aborted wait never keeps the
// process alive; `pause` honours an injected sleep (the tests' fake clock) and still returns at once on abort.
export const sleep = (ms, signal) => new Promise(done => {
  if (signal?.aborted) { done(); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); done(); }, ms);
  const stop = () => { clearTimeout(timer); done(); };
  signal?.addEventListener('abort', stop, { once: true });
});

export function pause(ms, { signal, sleep: wait = sleep } = {}) {
  if (!signal) return wait(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise(done => {
    const stop = () => done();
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(wait(ms, signal)).then(() => { signal.removeEventListener('abort', stop); done(); });
  });
}
