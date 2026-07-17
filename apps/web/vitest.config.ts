import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Tests share one local workspace-state database; file parallelism causes seed/version races.
    fileParallelism: false,
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${path.resolve(__dirname, ".")}/$1` },
      { find: /^@agent-space\/domain$/, replacement: path.resolve(__dirname, "../../packages/domain/src/index.ts") },
      { find: /^@agent-space\/domain\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/domain/src")}/$1.ts` },
      { find: /^@agent-space\/services$/, replacement: path.resolve(__dirname, "../../packages/services/src/index.ts") },
      { find: /^@agent-space\/services\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/services/src")}/$1.ts` },
      { find: /^@agent-space\/sandbox$/, replacement: path.resolve(__dirname, "../../packages/sandbox/src/index.ts") },
      { find: /^@agent-space\/sandbox\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/sandbox/src")}/$1.ts` },
      { find: /^@agent-space\/db$/, replacement: path.resolve(__dirname, "../../packages/db/src/index.ts") },
      { find: /^@agent-space\/db\/(.*)$/, replacement: `${path.resolve(__dirname, "../../packages/db/src")}/$1.ts` },
      { find: /^@agent-space\/db\/index$/, replacement: path.resolve(__dirname, "../../packages/db/src/index.ts") },
      { find: /^@agent-space\/db\/database$/, replacement: path.resolve(__dirname, "../../packages/db/src/database.ts") },
      { find: /^agent-space-daemon$/, replacement: path.resolve(__dirname, "../../packages/daemon/src/index.ts") },
      { find: /^agent-space-daemon\/agent-router$/, replacement: path.resolve(__dirname, "../../packages/daemon/src/agent-router/index.ts") },
      { find: /^agent-space-daemon\/daemon-client$/, replacement: path.resolve(__dirname, "../../packages/daemon/src/daemon-client.ts") },
    ],
  },
});
