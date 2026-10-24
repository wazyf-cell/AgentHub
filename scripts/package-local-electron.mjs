import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronDistDir = join(rootDir, "node_modules", "electron", "dist");
const electronExe = join(electronDistDir, "electron.exe");
const outputDir = join(rootDir, "dist-electron-local-out", "win-unpacked");
const appDir = join(outputDir, "resources", "app");
const targetElectronExe = join(outputDir, "AgentSpaceLocal.exe");

if (!existsSync(electronExe)) {
  throw new Error(`Electron runtime is missing: ${electronExe}. Run node node_modules/electron/install.js first.`);
}

let reusedRuntime = false;
try {
  rmSync(outputDir, { recursive: true, force: true });
} catch (error) {
  // A still-running instance (or a lingering handle) locks the Electron runtime
  // files. The app payload is ours to replace, so refresh only that.
  if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code)) throw error;
  rmSync(appDir, { recursive: true, force: true });
  reusedRuntime = true;
}
mkdirSync(outputDir, { recursive: true });

if (!reusedRuntime) {
  cpSync(electronDistDir, outputDir, {
    recursive: true,
    filter: (source) => !source.includes(`${String.raw`\resources\default_app.asar`}`),
  });

  const sourceElectronExe = join(outputDir, "electron.exe");
  if (existsSync(sourceElectronExe)) {
    copyFileSync(sourceElectronExe, targetElectronExe);
    rmSync(sourceElectronExe, { force: true });
  }
}

copyDir("electron", join(appDir, "electron"));
copyDir("packages/daemon/dist", join(appDir, "packages", "daemon", "dist"));
copyFile("packages/daemon/package.json", join(appDir, "packages", "daemon", "package.json"));
copyFile("agentspace.local.example.json", join(appDir, "agentspace.local.example.json"));
copyFile("LOCAL_AGENT_RUNNER.md", join(appDir, "LOCAL_AGENT_RUNNER.md"));

writeFileSync(join(appDir, "package.json"), `${JSON.stringify({
  name: "agent-space-local",
  version: "0.1.0",
  private: true,
  main: "electron/local-main.js",
}, null, 2)}\n`, "utf8");

console.log(`AgentSpace Local unpacked app created: ${targetElectronExe}`);

function copyDir(relativeSource, target) {
  const source = join(rootDir, relativeSource);
  if (!existsSync(source)) {
    throw new Error(`Missing required directory: ${source}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function copyFile(relativeSource, target) {
  const source = join(rootDir, relativeSource);
  if (!existsSync(source)) {
    throw new Error(`Missing required file: ${source}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
