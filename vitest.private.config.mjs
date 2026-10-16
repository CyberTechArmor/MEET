export default {
  esbuild: {jsx: 'automatic'},
  test: {
    include: ['api/src/nodus-*.test.ts', 'frontend/src/lib/nodusPrivate*.test.ts'],
    exclude: ['api/src/nodus-paired.test.ts'],
    fileParallelism: false,
  },
};
