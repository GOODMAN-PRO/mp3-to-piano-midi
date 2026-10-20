// Kim's largest storage tensor is 144 MiB; ask for adapter limits rather than
// WebGPU's smaller default device limits.
export const MIN_GPU_BUFFER_BYTES = 151_000_000;

export async function probeWebGPU(gpu = globalThis.navigator?.gpu) {
  try {
    if (!gpu) throw new Error('WebGPU is unavailable');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    if (adapter.info?.isFallbackAdapter === true || adapter.isFallbackAdapter === true) {
      throw new Error('The WebGPU adapter is software rendering');
    }
    for (const limit of ['maxStorageBufferBindingSize', 'maxBufferSize']) {
      if (!(adapter.limits[limit] >= MIN_GPU_BUFFER_BYTES)) {
        throw new Error(`WebGPU ${limit} is below 151 MB`);
      }
    }
    return { supported: true, adapter };
  } catch (error) {
    return { supported: false, reason: error.message || String(error) };
  }
}

export async function requestSeparationDevice(adapter) {
  return adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
}
