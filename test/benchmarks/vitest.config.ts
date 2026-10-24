import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/benchmarks/*.benchmark.ts'], environment: 'node',
    fileParallelism: false, maxWorkers: 1, testTimeout: 30000,
  },
})
