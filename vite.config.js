export default {
  base: './',
  worker: { format: 'es' },
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
};
