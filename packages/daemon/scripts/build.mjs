import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(rootDir, "dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    "agent-router": resolve(rootDir, "src", "agent-router", "cli.ts"),
    "agent-space-local": resolve(rootDir, "src", "local-agent-runner-cli.ts"),
    "agent-space-room": resolve(rootDir, "src", "room", "rooms-cli.ts"),
    "agent-space": resolve(rootDir, "..", "..", "apps", "cli", "src", "index.ts"),
    cli: resolve(rootDir, "src", "cli.ts"),
    index: resolve(rootDir, "src", "index.ts"),
    "daemon-client": resolve(rootDir, "src", "daemon-client.ts"),
    "agent-router/index": resolve(rootDir, "src", "agent-router", "index.ts"),
  },
  outdir: outDir,
  bundle: true,
  external: ["agent-space-daemon"],
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
});
