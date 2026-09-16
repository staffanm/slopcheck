export function semanticClient(onProgress) {
  let worker;
  let job;
  let nextId = 0;
  function stop(reason = new DOMException('Avbruten', 'AbortError')) {
    worker?.terminate();
    worker = undefined;
    job?.reject(reason);
    job = undefined;
  }
  async function assess(claim, evidence, signal) {
    signal.throwIfAborted();
    if (job) throw new Error('Endast en lokal jämförelse får köras åt gången.');
    if (!worker) {
      worker = new Worker(new URL('./semantic.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.id !== job?.id) return;
        if (data.progress) return onProgress(data.progress);
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.result);
      };
      worker.onerror = () => stop(new Error('Den lokala modellen kunde inte starta.'));
    }
    const timeout = setTimeout(() => stop(new Error('Den lokala jämförelsen tog mer än två minuter.')), 120000);
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        job = { id: ++nextId, resolve, reject };
        worker.postMessage({ id: job.id, base: new URL('.', document.baseURI).href, claim, evidence });
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      job = undefined;
    }
  }
  return { assess, stop };
}
