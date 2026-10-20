export const SEPARATION_MODEL = Object.freeze({
  url: 'https://huggingface.co/Politrees/UVR_resources/resolve/929e057b81aa49bc2e6490bef8671f47b2c120f6/models/MDXNet/Kim_Vocal_2.onnx',
  bytes: 66_759_214,
  sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
  cache: 'sep-models-v1',
});

export async function loadSeparationModel({
  signal, onProgress = () => {}, onWarning = () => {},
  fetchImpl = globalThis.fetch, cacheStorage = globalThis.caches,
  cryptoImpl = globalThis.crypto, model = SEPARATION_MODEL,
} = {}) {
  const check = () => signal?.throwIfAborted();
  const verify = async bytes => {
    if (bytes.byteLength !== model.bytes) throw new Error('Vocal model has the wrong size');
    const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== model.sha256) throw new Error('Vocal model SHA-256 verification failed');
    check();
  };
  let cache;
  check();
  try {
    cache = await cacheStorage?.open(model.cache);
  } catch {
    onWarning('Model caching is unavailable; continuing without caching.');
  }
  if (!cache && !cacheStorage) onWarning('Model caching is unavailable; continuing without caching.');
  if (cache) {
    try {
      const stored = await cache.match(model.url);
      if (stored) {
        onProgress({ frac: 0, cached: true, message: 'Checking cached vocal model...' });
        const bytes = await stored.arrayBuffer();
        await verify(bytes);
        onProgress({ frac: 1, cached: true, message: 'Cached vocal model ready.' });
        return bytes;
      }
    } catch (error) {
      check();
      onWarning(`Cached vocal model could not be used (${error.message}); downloading again.`);
      await cache.delete(model.url).catch(() => {});
    }
  }
  check();
  onProgress({ frac: 0, cached: false, loaded: 0, total: model.bytes });
  const response = await fetchImpl(model.url, { signal });
  if (!response.ok) throw new Error(`Vocal model download returned HTTP ${response.status}`);
  const bytes = new Uint8Array(model.bytes);
  let loaded = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        check();
        if (done) break;
        if (loaded + value.length > bytes.length) throw new Error('Vocal model has the wrong size');
        bytes.set(value, loaded);
        loaded += value.length;
        onProgress({ frac: loaded / model.bytes, cached: false, loaded, total: model.bytes });
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } else {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length !== bytes.length) throw new Error('Vocal model has the wrong size');
    bytes.set(body);
    loaded = body.length;
  }
  if (loaded !== model.bytes) throw new Error('Vocal model download was incomplete');
  onProgress({ frac: 1, cached: false, message: 'Verifying vocal model...' });
  await verify(bytes);
  if (cache) {
    try {
      await cache.put(model.url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch (error) {
      onWarning(error.name === 'QuotaExceededError'
        ? 'Model cache is full; continuing without caching. The model will download again next time.'
        : 'Model could not be cached; continuing without caching.');
    }
  }
  check();
  return bytes.buffer;
}
