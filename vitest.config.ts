import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Tests share a temp directory root and spawn git; keep files sequential for clarity.
    fileParallelism: false,
  },
});
