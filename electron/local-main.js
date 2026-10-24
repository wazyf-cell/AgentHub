const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require("electron");
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const APP_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
const USER_DATA_DIR = app.getPath("userData");
const LOCAL_CONFIG_PATH = path.join(USER_DATA_DIR, "agentspace.local.json");
const LOCAL_OUTPUT_DIR = path.join(USER_DATA_DIR, "runs");
const LOG_FILE = path.join(USER_DATA_DIR, "agent-space-local-desktop.log");
const ROOM_DATA_DIR = path.join(USER_DATA_DIR, "rooms");
const APP_SETTINGS_PATH = path.join(USER_DATA_DIR, "app-settings.json");
const SECRETS_PATH = path.join(USER_DATA_DIR, "secrets.json");
const ATTACHMENTS_DIR = path.join(USER_DATA_DIR, "attachments");

function readAppSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAppSettings(patch) {
  const settings = { ...readAppSettings(), ...patch };
  fs.mkdirSync(path.dirname(APP_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(APP_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

function secretEnvName(platformId) {
  const safe = String(platformId || "").replace(/[^a-zA-Z0-9_-]/g, "_").toUpperCase();
  return `AGENTHUB_KEY_${safe}`;
}

function readSecrets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSecrets(patch) {
  const secrets = { ...readSecrets(), ...patch };
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) delete secrets[key];
  }
  fs.writeFileSync(SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
  return secrets;
}

function decryptedSecrets() {
  const out = {};
  if (!safeStorage.isEncryptionAvailable()) return out;
  for (const [platformId, stored] of Object.entries(readSecrets())) {
    if (typeof stored !== "string" || !stored) continue;
    try {
      out[secretEnvName(platformId)] = safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      // A secret written on another machine cannot be opened here; ignore it.
    }
  }
  return out;
}

const TOOL_SPECS = {
  codegraph: {
    settingKey: "codegraphPath",
    envKey: "CODEGRAPH_BIN",
    label: "codegraph",
    command: "codegraph",
    args: ["--version"],
  },
  es: {
    settingKey: "everythingPath",
    envKey: "ES_BIN",
    label: "Everything es.exe",
    command: "es",
    args: ["-version"],
  },
};

function roomEnv() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const settings = readAppSettings();
  if (typeof settings.codegraphPath === "string" && settings.codegraphPath.trim()) {
    env.CODEGRAPH_BIN = settings.codegraphPath.trim();
  }
  if (typeof settings.everythingPath === "string" && settings.everythingPath.trim()) {
    env.ES_BIN = settings.everythingPath.trim();
  }
  Object.assign(env, decryptedSecrets());
  return env;
}

function probeBinary(command, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    let child;
    try {
      child = spawn(needsShell ? `"${command}"` : command, args, { windowsHide: true, shell: needsShell });
    } catch (error) {
      finish({ ok: false, detail: error.message });
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ ok: false, detail: "检测超时" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, detail: error.code === "ENOENT" ? "未找到可执行文件" : error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Windows CLI errors are usually GBK; version banners are ASCII.
      const decoder = new TextDecoder(process.platform === "win32" ? "gbk" : "utf-8");
      const output = decoder.decode(Buffer.concat(chunks));
      const line = output.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
      if (code === 0) finish({ ok: true, version: line || "可用" });
      else finish({ ok: false, detail: line || `退出码 ${code}` });
    });
  });
}

let mainWindow = null;
let activeRun = null;
let activeRoomRun = null;
let roomStopRequested = false;
const activeTaskRuns = new Map();

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never crash desktop startup.
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: "AgentHub Room",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "room-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "room.html")).catch((error) => {
    log(`failed to load room UI: ${error.stack || error.message || String(error)}`);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildBaseCliArgs(command, args = []) {
  const builtCliEntry = path.join(APP_ROOT, "packages", "daemon", "dist", "agent-space-local.js");
  if (fs.existsSync(builtCliEntry)) {
    return [builtCliEntry, command, ...args];
  }

  const sourceCliEntry = path.join(APP_ROOT, "packages", "daemon", "src", "local-agent-runner-cli.ts");
  return ["--experimental-strip-types", sourceCliEntry, command, ...args];
}

function spawnLocalCli(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, buildBaseCliArgs(command, args), {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      resolve({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    options.onChild?.(child);
  });
}

function buildRoomCliArgs(command, args = []) {
  const builtCliEntry = path.join(APP_ROOT, "packages", "daemon", "dist", "agent-space-room.js");
  if (fs.existsSync(builtCliEntry)) {
    return [builtCliEntry, command, ...args];
  }
  const sourceCliEntry = path.join(APP_ROOT, "packages", "daemon", "src", "room", "rooms-cli.ts");
  return ["--experimental-strip-types", sourceCliEntry, command, ...args];
}

function spawnRoomCli(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, buildRoomCliArgs(command, args), {
      cwd: APP_ROOT,
      env: roomEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      resolve({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    options.onChild?.(child);
  });
}

function ensureLocalConfig() {
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    return { created: false, configPath: LOCAL_CONFIG_PATH };
  }
  fs.mkdirSync(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
  const examplePath = path.join(APP_ROOT, "agentspace.local.example.json");
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, LOCAL_CONFIG_PATH);
  } else {
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify({
      version: 1,
      cwd: ".",
      outputDir: ".agentspace/runs",
      agents: [
        {
          id: "planner",
          name: "Planner",
          harness: "codex",
          role: "Break down the task and produce a short implementation plan.",
        },
        {
          id: "reviewer",
          name: "Reviewer",
          harness: "codex",
          role: "Review the plan and identify risks or missing steps.",
        },
      ],
    }, null, 2));
  }
  return { created: true, configPath: LOCAL_CONFIG_PATH };
}

function readSettings() {
  ensureLocalConfig();
  return {
    appRoot: APP_ROOT,
    userDataDir: USER_DATA_DIR,
    configPath: LOCAL_CONFIG_PATH,
    outputDir: LOCAL_OUTPUT_DIR,
    logFile: LOG_FILE,
    defaultCwd: APP_ROOT,
  };
}

ipcMain.handle("local:settings", () => readSettings());

ipcMain.handle("local:init", async () => {
  const result = ensureLocalConfig();
  return {
    status: "success",
    summary: result.created ? "Local config created." : "Local config already exists.",
    ...readSettings(),
  };
});

ipcMain.handle("local:detect", async () => {
  const result = await spawnLocalCli("detect");
  if (result.exitCode !== 0) {
    return {
      status: "error",
      summary: result.error || result.stderr || "Provider detection failed.",
      raw: result,
    };
  }
  try {
    return {
      status: "success",
      summary: "Provider detection finished.",
      data: JSON.parse(result.stdout),
    };
  } catch {
    return {
      status: "warning",
      summary: "Provider detection finished but output was not JSON.",
      raw: result,
    };
  }
});

ipcMain.handle("local:run", async (_event, input) => {
  if (activeRun) {
    return {
      status: "error",
      summary: "A local agent run is already active.",
    };
  }

  const prompt = String(input?.prompt || "").trim();
  if (!prompt) {
    return {
      status: "error",
      summary: "Task prompt is required.",
    };
  }

  ensureLocalConfig();
  fs.mkdirSync(LOCAL_OUTPUT_DIR, { recursive: true });
  const cwd = String(input?.cwd || APP_ROOT).trim() || APP_ROOT;
  const agents = String(input?.agents || "").trim();
  const mode = String(input?.mode || "auto").trim();
  const args = [
    "--config", LOCAL_CONFIG_PATH,
    "--cwd", cwd,
    "--output-dir", LOCAL_OUTPUT_DIR,
    "--mode", mode,
    "--json-events",
  ];
  if (agents) {
    args.push("--agents", agents);
  }
  args.push(prompt);

  let stdoutBuffer = "";
  const events = [];
  const result = await spawnLocalCli("run", args, {
    onChild: (child) => {
      activeRun = child;
    },
    onStdout: (text) => {
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed);
          events.push(parsed);
          mainWindow?.webContents.send("local:run-event", parsed);
        } catch {
          mainWindow?.webContents.send("local:run-log", trimmed);
        }
      }
    },
    onStderr: (text) => {
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        mainWindow?.webContents.send("local:run-log", line);
      }
    },
  });
  activeRun = null;

  let finalResult = events.findLast?.((event) => event.type === "result")
    || [...events].reverse().find((event) => event.type === "result");
  if (!finalResult && stdoutBuffer.trim()) {
    try {
      finalResult = JSON.parse(stdoutBuffer.trim());
    } catch {
      // Ignore; raw stdout is returned below.
    }
  }

  return {
    status: result.exitCode === 0 ? "success" : "error",
    summary: result.exitCode === 0 ? "Local agent run completed." : "Local agent run failed.",
    exitCode: result.exitCode,
    result: finalResult,
    raw: result,
  };
});

ipcMain.handle("local:cancel", () => {
  if (!activeRun) {
    return { status: "warning", summary: "No active run." };
  }
  activeRun.kill("SIGTERM");
  activeRun = null;
  return { status: "success", summary: "Cancel signal sent." };
});

ipcMain.handle("local:open-path", async (_event, targetPath) => {
  const value = String(targetPath || "").trim();
  if (!value) {
    return { status: "error", summary: "Path is required." };
  }
  const error = await shell.openPath(value);
  return error ? { status: "error", summary: error } : { status: "success", summary: "Opened." };
});

// Every room call starts a fresh Node process (~190ms). Without a cap, rapid
// clicking queues dozens of them and the window stops responding.
const ROOM_CLI_MAX_CONCURRENT = 3;
const ROOM_CLI_UNQUEUED = new Set(["compact", "graph"]);
const roomCliQueue = [];
const roomCliInflight = new Map();
let roomCliActive = 0;

function pumpRoomCli() {
  while (roomCliActive < ROOM_CLI_MAX_CONCURRENT && roomCliQueue.length > 0) {
    const start = roomCliQueue.shift();
    roomCliActive += 1;
    start();
  }
}

function enqueueRoomCli(task) {
  return new Promise((resolve) => {
    const run = () => {
      task()
        .then(resolve)
        .finally(() => {
          roomCliActive -= 1;
          pumpRoomCli();
        });
    };
    roomCliQueue.push(run);
    pumpRoomCli();
  });
}

function runRoomCliJson(command, args) {
  return spawnRoomCli(command, [...args, "--data-dir", ROOM_DATA_DIR]).then((result) => {
    if (result.exitCode !== 0) {
      return {
        status: "error",
        summary: result.error || result.stderr || result.stdout || "Room command failed.",
        raw: result,
      };
    }
    try {
      return { status: "success", data: JSON.parse(result.stdout) };
    } catch {
      return { status: "warning", summary: "Room command output was not JSON.", raw: result };
    }
  });
}

async function runRoomJson(command, args = []) {
  if (ROOM_CLI_UNQUEUED.has(command)) return runRoomCliJson(command, args);
  const key = `${command} ${args.join(" ")}`;
  const existing = roomCliInflight.get(key);
  if (existing) return existing;
  const promise = enqueueRoomCli(() => runRoomCliJson(command, args));
  roomCliInflight.set(key, promise);
  promise.finally(() => roomCliInflight.delete(key));
  return promise;
}

async function runRoomLines(command, args = []) {
  const result = await spawnRoomCli(command, [...args, "--data-dir", ROOM_DATA_DIR]);
  if (result.exitCode !== 0) {
    return { status: "error", summary: result.stderr || result.stdout || "Room command failed.", raw: result };
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      return { status: "warning", summary: "Replay output contained a non-JSON line.", raw: result };
    }
  }
  return { status: "success", data: events };
}

ipcMain.handle("room:settings", () => ({
  dataDir: ROOM_DATA_DIR,
  appRoot: APP_ROOT,
  homeDir: os.homedir(),
  logFile: LOG_FILE,
  appVersion: app.getVersion(),
  attachmentsDir: ATTACHMENTS_DIR,
  codegraphPath: readAppSettings().codegraphPath || "",
  everythingPath: readAppSettings().everythingPath || "",
}));

ipcMain.handle("room:pick-tool-path", async (_event, input) => {
  const tool = String(input?.tool || "").trim();
  const spec = TOOL_SPECS[tool];
  if (!spec) return { status: "error", summary: "不支持的工具。" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `选择 ${spec.label} 可执行文件`,
    properties: ["openFile"],
    filters: process.platform === "win32"
      ? [{ name: "可执行文件", extensions: ["exe", "cmd", "bat"] }, { name: "全部文件", extensions: ["*"] }]
      : [{ name: "全部文件", extensions: ["*"] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { status: "warning", summary: "未选择文件" };
  }
  return { status: "success", path: result.filePaths[0] };
});

ipcMain.handle("room:set-tool", async (_event, input) => {
  const tool = String(input?.tool || "").trim();
  const spec = TOOL_SPECS[tool];
  if (!spec) {
    return { status: "error", summary: "不支持的工具。当前支持 codegraph 与 Everything（es）。" };
  }
  const target = String(input?.path || "").trim();
  if (target && path.isAbsolute(target) && !fs.existsSync(target)) {
    return { status: "error", summary: `路径不存在：${target}。未保存。`, tool, path: target, available: false };
  }
  if (!target) writeAppSettings({ [spec.settingKey]: "" });
  const effective = target || process.env[spec.envKey] || spec.command;
  const probe = await probeBinary(effective, spec.args);
  if (!probe.ok) {
    const detail = String(probe.detail || "未知错误").replace(/[。.!！]+$/u, "");
    return {
      status: "error",
      summary: target
        ? `${spec.label} 未连通：${detail}。路径未保存。`
        : `已清空路径，但自动检测未找到 ${spec.label}：${detail}。`,
      tool,
      path: target,
      available: false,
    };
  }
  writeAppSettings({ [spec.settingKey]: target });
  return {
    status: "success",
    summary: target
      ? `${spec.label} 已连通（${probe.version}），路径已保存。`
      : `已恢复为自动检测（${probe.version}）。`,
    tool,
    path: target,
    available: true,
    version: probe.version,
  };
});

ipcMain.handle("room:secret-set", async (_event, input) => {
  const platformId = String(input?.platformId || "").trim();
  const value = String(input?.value || "");
  if (!platformId) return { status: "error", summary: "平台 id 不能为空。" };
  const envName = secretEnvName(platformId);
  if (!value) {
    writeSecrets({ [platformId]: "" });
    return { status: "success", summary: "密钥已删除", envName: "" };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { status: "error", summary: "本机加密存储不可用，请改用环境变量方式。" };
  }
  writeSecrets({ [platformId]: safeStorage.encryptString(value).toString("base64") });
  const updated = await runRoomJson("platform", ["update", "--id", platformId, "--api-key-env", envName, "--json"]);
  return updated.status === "success"
    ? { status: "success", summary: `密钥已加密保存（Windows 登录用户绑定），变量名 ${envName}`, envName }
    : { status: "warning", summary: `密钥已保存，但平台变量名未更新：${updated.summary || ""}`, envName };
});

ipcMain.handle("room:secret-status", (_event, platformId) => {
  const id = String(platformId || "").trim();
  return { status: "success", saved: Boolean(readSecrets()[id]), envName: secretEnvName(id) };
});

ipcMain.handle("room:models-pull", (_event, input) => {
  const platformId = String(input?.platformId || "").trim();
  if (!platformId) return { status: "error", summary: "平台 id 不能为空。" };
  return runRoomJson("models", ["pull", "--platform", platformId, "--json"]);
});

ipcMain.handle("room:models-add", (_event, input) => {
  const platformId = String(input?.platformId || "").trim();
  const selected = Array.isArray(input?.models) ? input.models.map((id) => String(id)) : [];
  if (!platformId || selected.length === 0) return { status: "error", summary: "平台和模型不能为空。" };
  const args = ["add", "--platform", platformId, "--json"];
  for (const id of selected) args.push("--select", id);
  if (input?.defaultModel) args.push("--default-model", String(input.defaultModel));
  if (input?.context) args.push("--context", String(input.context));
  if (input?.input) args.push("--input", String(input.input));
  return runRoomJson("models", args);
});

function attachmentRoomDir(roomId) {
  const safe = String(roomId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("Room id is required.");
  const dir = path.join(ATTACHMENTS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function imagePayload(filePath) {
  const data = fs.readFileSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".webp"
      ? "image/webp"
      : extension === ".gif"
        ? "image/gif"
        : extension === ".bmp"
          ? "image/bmp"
          : "image/png";
  return {
    path: filePath,
    name: path.basename(filePath),
    dataUrl: `data:${mime};base64,${data.toString("base64")}`,
  };
}

ipcMain.handle("room:pick-images", async (_event, input) => {
  let roomId;
  try {
    roomId = attachmentRoomDir(input?.roomId);
  } catch (error) {
    return { status: "error", summary: error.message };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择图片附件",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { status: "warning", summary: "未选择图片" };
  }
  try {
    const images = [];
    for (const source of result.filePaths) {
      if (fs.statSync(source).size > 15 * 1024 * 1024) {
        return { status: "error", summary: `${path.basename(source)} 超过 15MB，未添加` };
      }
      const target = path.join(roomId, `${randomUUID()}${path.extname(source).toLowerCase() || ".png"}`);
      fs.copyFileSync(source, target);
      images.push(imagePayload(target));
    }
    return { status: "success", data: images };
  } catch (error) {
    return { status: "error", summary: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("room:save-image", (_event, input) => {
  try {
    const dir = attachmentRoomDir(input?.roomId);
    const dataUrl = String(input?.dataUrl || "");
    const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
      return { status: "error", summary: "粘贴内容不是图片。" };
    }
    const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 15 * 1024 * 1024) {
      return { status: "error", summary: "图片超过 15MB。" };
    }
    const target = path.join(dir, `${randomUUID()}.${extension}`);
    fs.writeFileSync(target, buffer);
    return { status: "success", data: imagePayload(target) };
  } catch (error) {
    return { status: "error", summary: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("room:stats", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  if (!roomId) return { status: "error", summary: "Room id is required." };
  const args = ["--json", "--room", roomId];
  if (input?.since) args.push("--since", String(input.since));
  return runRoomJson("stats", args);
});

ipcMain.handle("room:compact", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  if (!roomId) return { status: "error", summary: "Room id is required." };
  return runRoomJson("compact", ["--json", "--room", roomId]);
});

ipcMain.handle("room:brief-show", (_event, roomId) => {
  const id = String(roomId || "").trim();
  if (!id) return { status: "error", summary: "Room id is required." };
  return runRoomJson("brief", ["show", "--json", "--room", id]);
});

ipcMain.handle("room:brief-set", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const text = String(input?.text ?? "");
  if (!roomId) return { status: "error", summary: "Room id is required." };
  if (text.length > 40_000) return { status: "error", summary: "简报过长（上限 40000 字）。" };
  return runRoomJson("brief", ["set", "--json", "--room", roomId, "--text", text]);
});

ipcMain.handle("room:files", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  if (!roomId) return { status: "error", summary: "Room id is required." };
  const args = ["files", "--json", "--room", roomId];
  if (input?.query) args.push("--query", String(input.query));
  if (input?.limit) args.push("--limit", String(input.limit));
  if (input?.workspace) args.push("--workspace", String(input.workspace));
  return runRoomJson("inspect", args);
});

ipcMain.handle("room:pick-workspace", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择房间工作区",
    defaultPath: os.homedir(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { status: "warning", summary: "未选择目录" };
  }
  return { status: "success", path: result.filePaths[0] };
});

ipcMain.handle("room:list", () => runRoomJson("list", ["--json"]));

ipcMain.handle("room:show", (_event, roomId) => {
  const id = String(roomId || "").trim();
  if (!id) {
    return { status: "error", summary: "Room id is required." };
  }
  return runRoomJson("show", ["--json", "--room", id]);
});

ipcMain.handle("room:full", (_event, roomId) => {
  const id = String(roomId || "").trim();
  if (!id) {
    return { status: "error", summary: "Room id is required." };
  }
  return runRoomJson("full", ["--json", "--room", id]);
});

ipcMain.handle("room:events", (_event, roomId) => {
  const id = String(roomId || "").trim();
  if (!id) {
    return { status: "error", summary: "Room id is required." };
  }
  return runRoomLines("replay", ["--json", "--room", id]);
});

ipcMain.handle("room:platforms", () => runRoomJson("platforms", ["--json", "--health"]));

ipcMain.handle("room:models", () => runRoomJson("models", ["--json"]));

ipcMain.handle("room:capabilities", () => runRoomJson("capabilities", ["--json"]));

ipcMain.handle("room:workspaces", () => runRoomJson("workspace", ["list", "--json"]));

ipcMain.handle("room:workspace-add", (_event, input) => {
  const name = String(input?.name || "").trim();
  const target = String(input?.path || "").trim();
  if (!name || !target) {
    return { status: "error", summary: "工作区名称和路径不能为空。" };
  }
  return runRoomJson("workspace", ["add", "--name", name, "--workspace", target, "--json"]);
});

ipcMain.handle("room:workspace-rename", (_event, input) => {
  const id = String(input?.id || "").trim();
  const name = String(input?.name || "").trim();
  if (!id || !name) {
    return { status: "error", summary: "工作区 id 和名称不能为空。" };
  }
  return runRoomJson("workspace", ["rename", "--id", id, "--name", name, "--json"]);
});

ipcMain.handle("room:workspace-remove", (_event, input) => {
  const id = String(input?.id || "").trim();
  if (!id) {
    return { status: "error", summary: "工作区 id 不能为空。" };
  }
  return runRoomJson("workspace", ["remove", "--id", id, "--json"]);
});

ipcMain.handle("room:create", (_event, input) => {
  const name = String(input?.name || "").trim();
  if (!name) {
    return { status: "error", summary: "房间名称不能为空。" };
  }
  const args = ["create", "--name", name, "--json"];
  if (input?.id) {
    args.push("--id", String(input.id));
  }
  if (input?.noWorkspace === true) {
    args.push("--no-workspace");
  } else if (input?.workspaceId) {
    args.push("--workspace-id", String(input.workspaceId));
  } else if (input?.workspacePath) {
    args.push("--workspace", String(input.workspacePath));
  }
  if (input?.copyFromRoomId) {
    args.push("--copy-from", String(input.copyFromRoomId));
  }
  for (const memberId of Array.isArray(input?.libraryMemberIds) ? input.libraryMemberIds : []) {
    args.push("--library-member", String(memberId));
  }
  if (input?.defaultPlatformId && input?.defaultModelId) {
    args.push("--platform", String(input.defaultPlatformId), "--model", String(input.defaultModelId));
  }
  return runRoomJson("create", args);
});

ipcMain.handle("room:delete", async (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  if (!roomId) return { status: "error", summary: "房间 id 不能为空。" };
  const args = ["delete", "--room", roomId, "--json"];
  if (input?.force === true) args.push("--force");
  const result = await runRoomJson("delete", args);
  if (result.status === "success") {
    const safe = roomId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (safe) fs.rmSync(path.join(ATTACHMENTS_DIR, safe), { recursive: true, force: true });
  }
  return result;
});

function cleanupOrphanAttachments() {
  const summary = { removedDirs: 0, removedFiles: 0, freedBytes: 0 };
  if (!fs.existsSync(ATTACHMENTS_DIR)) return summary;
  const rooms = new Set();
  if (fs.existsSync(ROOM_DATA_DIR)) {
    for (const entry of fs.readdirSync(ROOM_DATA_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(ROOM_DATA_DIR, entry.name, "room.json"))) {
        rooms.add(entry.name);
      }
    }
  }
  const dirSize = (dir) => {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      try {
        total += entry.isDirectory() ? dirSize(target) : fs.statSync(target).size;
      } catch {
        // A file may disappear while scanning.
      }
    }
    return total;
  };
  for (const entry of fs.readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ATTACHMENTS_DIR, entry.name);
    if (!rooms.has(entry.name)) {
      summary.freedBytes += dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      summary.removedDirs += 1;
      continue;
    }
    const referenced = new Set();
    const eventsPath = path.join(ROOM_DATA_DIR, entry.name, "events.jsonl");
    if (fs.existsSync(eventsPath)) {
      for (const line of fs.readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          for (const image of Array.isArray(event.images) ? event.images : []) {
            if (typeof image === "string") referenced.add(path.resolve(image));
          }
        } catch {
          // Ignore a corrupt journal line when deciding what is referenced.
        }
      }
    }
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const target = path.join(dir, file.name);
      if (referenced.has(path.resolve(target))) continue;
      try {
        summary.freedBytes += fs.statSync(target).size;
        fs.rmSync(target, { force: true });
        summary.removedFiles += 1;
      } catch {
        // Leave files we cannot remove; the next scan will retry.
      }
    }
  }
  return summary;
}

ipcMain.handle("room:cleanup-attachments", () => {
  try {
    return { status: "success", data: cleanupOrphanAttachments() };
  } catch (error) {
    return { status: "error", summary: error.message };
  }
});

function roomArgs(roomId) {
  const args = ["--room", String(roomId || "")];
  return args;
}

ipcMain.handle("room:member-library", () => runRoomJson("member", ["list", "--all", "--json"]));

ipcMain.handle("room:member-add", (_event, input) => {
  const name = String(input?.name || "").trim();
  const instructions = String(input?.instructions || "").trim();
  if (!name || !instructions) {
    return { status: "error", summary: "成员名称和提示词不能为空。" };
  }
  const args = ["add", "--name", name, "--instructions", instructions, "--json"];
  for (const [key, flag] of [
    ["role", "--role"],
    ["category", "--category"],
    ["avatar", "--avatar"],
    ["description", "--description"],
  ]) {
    if (input?.[key]) args.push(flag, String(input[key]));
  }
  for (const tag of Array.isArray(input?.tags) ? input.tags : []) args.push("--tag", String(tag));
  for (const skill of Array.isArray(input?.skills) ? input.skills : []) args.push("--skill", String(skill));
  for (const mcp of Array.isArray(input?.mcps) ? input.mcps : []) args.push("--mcp", String(mcp));
  return runRoomJson("member", args);
});

ipcMain.handle("room:member-update", (_event, input) => {
  const id = String(input?.id || "").trim();
  if (!id) return { status: "error", summary: "成员 id 不能为空。" };
  const args = ["update", "--id", id, "--json"];
  for (const [key, flag] of [
    ["name", "--name"],
    ["role", "--role"],
    ["category", "--category"],
    ["avatar", "--avatar"],
    ["description", "--description"],
    ["instructions", "--instructions"],
  ]) {
    if (input?.[key] !== undefined) args.push(flag, String(input[key]));
  }
  if (Array.isArray(input?.tags)) {
    if (input.tags.length === 0) args.push("--tag", "");
    for (const tag of input.tags) args.push("--tag", String(tag));
  }
  if (Array.isArray(input?.skills)) {
    if (input.skills.length === 0) args.push("--skill", "");
    for (const skill of input.skills) args.push("--skill", String(skill));
  }
  if (Array.isArray(input?.mcps)) {
    if (input.mcps.length === 0) args.push("--mcp", "");
    for (const mcp of input.mcps) args.push("--mcp", String(mcp));
  }
  if (input?.hidden === true) args.push("--hidden");
  if (input?.hidden === false) args.push("--visible");
  return runRoomJson("member", args);
});

ipcMain.handle("room:member-remove", (_event, id) => {
  const memberId = String(id || "").trim();
  if (!memberId) return { status: "error", summary: "成员 id 不能为空。" };
  return runRoomJson("member", ["remove", "--id", memberId, "--json"]);
});

ipcMain.handle("room:member-restore", (_event, id) => {
  const memberId = String(id || "").trim();
  if (!memberId) return { status: "error", summary: "成员 id 不能为空。" };
  return runRoomJson("member", ["restore", "--id", memberId, "--json"]);
});

ipcMain.handle("room:draft-show", (_event, input) => {
  const runId = String(input?.runId || "").trim();
  if (!runId) return { status: "error", summary: "草稿 id 不能为空。" };
  return runRoomJson("draft", ["show", "--run-id", runId, "--json"]);
});

ipcMain.handle("room:draft-apply", (_event, input) => {
  const runId = String(input?.runId || "").trim();
  if (!runId) return { status: "error", summary: "草稿 id 不能为空。" };
  const args = ["apply", "--run-id", runId, "--json"];
  for (const file of Array.isArray(input?.files) ? input.files : []) {
    args.push("--file", String(file));
  }
  return runRoomJson("draft", args);
});

ipcMain.handle("room:draft-discard", (_event, input) => {
  const runId = String(input?.runId || "").trim();
  if (!runId) return { status: "error", summary: "草稿 id 不能为空。" };
  return runRoomJson("draft", ["discard", "--run-id", runId]);
});

ipcMain.handle("room:draft-list", (_event, input) => {
  const args = ["list", "--json"];
  if (input?.workspaceId) args.push("--workspace-id", String(input.workspaceId));
  return runRoomJson("draft", args);
});

ipcMain.handle("room:task-list", (_event, input) => {
  const args = ["list", "--json"];
  if (input?.all === true) args.push("--all");
  return runRoomJson("task", [...args, ...roomArgs(input?.roomId)]);
});

ipcMain.handle("room:task-all", (_event, input) => {
  const args = ["all", "--json"];
  if (input?.all === true) args.push("--all");
  return runRoomJson("task", args);
});

ipcMain.handle("room:task-cleanup-worktrees", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  if (!roomId) return { status: "error", summary: "房间 id 不能为空。" };
  const args = ["cleanup-worktrees", "--json", "--room", roomId];
  if (input?.force === true) args.push("--force");
  return runRoomJson("task", args);
});

ipcMain.handle("room:task-archive", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  const sub = input?.archived === false ? "restore-archive" : "archive";
  return runRoomJson("task", [sub, "--task", taskId, "--json", "--room", roomId]);
});

ipcMain.handle("room:task-show", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  return runRoomJson("task", ["show", "--task", taskId, "--json", "--room", roomId]);
});

ipcMain.handle("room:task-create", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const title = String(input?.title || "").trim();
  if (!roomId || !title) return { status: "error", summary: "房间和任务标题不能为空。" };
  const args = [
    "create",
    "--title", title,
    "--description", String(input?.description || ""),
    "--owner", String(input?.ownerMemberId || ""),
    "--acceptance", String(input?.acceptance || ""),
    "--json",
    "--room", roomId,
  ];
  for (const dep of input?.dependsOn || []) args.push("--depends-on", String(dep));
  if (input?.verificationCommand) args.push("--verification", String(input.verificationCommand));
  for (const path of input?.allowedPaths || []) args.push("--allowed-path", String(path));
  for (const pin of input?.pinnedMessages || []) args.push("--pin", String(pin));
  if (input?.budgetYuan !== undefined && input.budgetYuan !== null && input.budgetYuan !== "") {
    args.push("--budget", String(input.budgetYuan));
  }
  if (input?.autoMerge === true) args.push("--auto-merge");
  if (input?.reviewerMemberId) args.push("--reviewer", String(input.reviewerMemberId));
  if (input?.sourceMessageId) args.push("--source-message", String(input.sourceMessageId));
  return runRoomJson("task", args);
});

ipcMain.handle("room:task-update", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  const args = ["update", "--task", taskId, "--json", "--room", roomId];
  for (const [key, flag] of [
    ["title", "--title"],
    ["description", "--description"],
    ["ownerMemberId", "--owner"],
    ["acceptance", "--acceptance"],
    ["verificationCommand", "--verification"],
  ]) {
    if (input?.[key] !== undefined) args.push(flag, String(input[key]));
  }
  if (Array.isArray(input?.dependsOn)) {
    if (input.dependsOn.length === 0) args.push("--depends-on", "");
    for (const dep of input.dependsOn) args.push("--depends-on", String(dep));
  }
  if (Array.isArray(input?.allowedPaths)) {
    if (input.allowedPaths.length === 0) args.push("--allowed-path", "");
    for (const path of input.allowedPaths) args.push("--allowed-path", String(path));
  }
  if (Array.isArray(input?.pinnedMessages)) {
    if (input.pinnedMessages.length === 0) args.push("--pin", "");
    for (const pin of input.pinnedMessages) args.push("--pin", String(pin));
  }
  if (input?.budgetYuan !== undefined) args.push("--budget", input.budgetYuan === null ? "" : String(input.budgetYuan));
  if (input?.autoMerge === true) args.push("--auto-merge");
  if (input?.reviewerMemberId !== undefined) args.push("--reviewer", String(input.reviewerMemberId || ""));
  return runRoomJson("task", args);
});

ipcMain.handle("room:task-move", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  const status = String(input?.status || "").trim();
  if (!roomId || !taskId || !status) return { status: "error", summary: "房间、任务和状态不能为空。" };
  return runRoomJson("task", ["move", "--task", taskId, "--status", status, "--json", "--room", roomId]);
});

ipcMain.handle("room:task-merge", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  return runRoomJson("task", ["merge", "--task", taskId, "--json", "--room", roomId]);
});

ipcMain.handle("room:task-discard", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  const args = ["discard", "--task", taskId, "--json", "--room", roomId];
  if (input?.force === true) args.push("--force");
  return runRoomJson("task", args);
});

ipcMain.handle("room:task-retry", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  return runRoomJson("task", ["retry", "--task", taskId, "--json", "--room", roomId]);
});

ipcMain.handle("room:task-recover", (_event, roomId) => {
  const id = String(roomId || "").trim();
  if (!id) return { status: "error", summary: "房间 id 不能为空。" };
  return runRoomJson("task", ["recover", "--json", "--room", id]);
});

ipcMain.handle("room:task-events", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  return runRoomJson("task", ["events", "--task", taskId, "--json", "--room", roomId]);
});

ipcMain.handle("room:task-run", async (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const taskId = String(input?.taskId || "").trim();
  if (!roomId || !taskId) return { status: "error", summary: "房间和任务 id 不能为空。" };
  if (activeTaskRuns.has(taskId)) {
    return { status: "error", summary: "该任务已在运行。" };
  }
  let stdout = "";
  let stderr = "";
  const result = await spawnRoomCli("task", [
    "run", "--task", taskId, "--json",
    "--room", roomId,
    "--data-dir", ROOM_DATA_DIR,
  ], {
    onChild: (child) => activeTaskRuns.set(taskId, child),
    onStdout: (text) => { stdout += text; },
    onStderr: (text) => {
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        mainWindow?.webContents.send("room:task-log", { taskId, line });
      }
    },
  });
  activeTaskRuns.delete(taskId);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = undefined;
  }
  mainWindow?.webContents.send("room:task-finished", {
    taskId,
    exitCode: result.exitCode,
    data,
    stderr: stderr.trim(),
  });
  return {
    status: result.exitCode === 0 ? "success" : "error",
    summary: data?.error || (stderr.trim().split(/\r?\n/).pop() || ""),
    data,
    stderr: stderr.trim(),
  };
});

ipcMain.handle("room:task-stop", async (_event, input) => {
  const taskId = String(input?.taskId || "").trim();
  const roomId = String(input?.roomId || "").trim();
  const child = activeTaskRuns.get(taskId);
  if (!child) return { status: "warning", summary: "该任务没有在运行。" };
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  activeTaskRuns.delete(taskId);
  if (roomId) {
    fs.rmSync(path.join(ROOM_DATA_DIR, roomId, "locks", `${taskId}.lock`), { force: true });
    await spawnRoomCli("task", [
      "move", "--task", taskId, "--status", "interrupted",
      "--room", roomId, "--data-dir", ROOM_DATA_DIR, "--json",
    ]);
  }
  return { status: "success", summary: "已停止任务；worktree 保留。" };
});

ipcMain.handle("room:inspect", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const sub = String(input?.sub || "tree");
  if (!roomId) return { status: "error", summary: "房间 id 不能为空。" };
  const args = [sub, "--json", "--room", roomId];
  if (input?.workspace) args.push("--workspace", String(input.workspace));
  if (input?.path) args.push("--path", String(input.path));
  if (input?.depth !== undefined) args.push("--depth", String(input.depth));
  if (Array.isArray(input?.files) && input.files[0]) args.push("--file", String(input.files[0]));
  if (input?.file) args.push("--file", String(input.file));
  if (input?.offset !== undefined) args.push("--offset", String(input.offset));
  if (input?.query !== undefined) args.push("--query", String(input.query));
  if (input?.limit !== undefined) args.push("--limit", String(input.limit));
  if (input?.staged === true) args.push("--staged");
  return runRoomJson("inspect", args);
});

ipcMain.handle("room:graph", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const sub = String(input?.sub || "status");
  if (!roomId) return { status: "error", summary: "房间 id 不能为空。" };
  const args = [sub, "--json", "--room", roomId];
  if (input?.workspace) args.push("--workspace", String(input.workspace));
  if (input?.query) args.push("--query", String(input.query));
  if (input?.target) args.push("--target", String(input.target));
  return runRoomJson("graph", args);
});

ipcMain.handle("room:btw-ask", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const question = String(input?.question || "").trim();
  if (!roomId || !question) return { status: "error", summary: "房间和问题不能为空。" };
  const args = ["ask", "--question", question, "--json", "--room", roomId];
  if (input?.memberId) args.push("--member", String(input.memberId));
  return runRoomJson("btw", args);
});

ipcMain.handle("room:btw-list", (_event, roomId) => {
  const id = String(roomId || "").trim();
  if (!id) return { status: "error", summary: "房间 id 不能为空。" };
  return runRoomJson("btw", ["list", "--json", "--room", id]);
});

ipcMain.handle("room:btw-promote", (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const btwId = String(input?.btwId || "").trim();
  if (!roomId || !btwId) return { status: "error", summary: "房间和 btw id 不能为空。" };
  return runRoomJson("btw", ["promote", "--btw", btwId, "--json", "--room", roomId]);
});

ipcMain.handle("room:platform-add", (_event, input) => {
  const args = ["add", "--json"];
  for (const [key, flag] of [
    ["id", "--id"],
    ["name", "--name"],
    ["kind", "--kind"],
    ["harness", "--harness"],
    ["baseUrl", "--base-url"],
    ["apiKeyEnv", "--api-key-env"],
    ["sandboxMode", "--sandbox-mode"],
    ["permissionMode", "--permission-mode"],
    ["commandTemplate", "--command-template"],
    ["defaultModel", "--default-model"],
    ["timeoutMs", "--timeout"],
  ]) {
    if (input?.[key] !== undefined && input[key] !== "") args.push(flag, String(input[key]));
  }
  if (input?.enabled === false) args.push("--disabled");
  return runRoomJson("platform", args);
});

ipcMain.handle("room:platform-update", (_event, input) => {
  const id = String(input?.id || "").trim();
  if (!id) return { status: "error", summary: "平台 id 不能为空。" };
  const args = ["update", "--id", id, "--json"];
  for (const [key, flag] of [
    ["name", "--name"],
    ["kind", "--kind"],
    ["harness", "--harness"],
    ["baseUrl", "--base-url"],
    ["apiKeyEnv", "--api-key-env"],
    ["sandboxMode", "--sandbox-mode"],
    ["permissionMode", "--permission-mode"],
    ["commandTemplate", "--command-template"],
    ["defaultModel", "--default-model"],
    ["timeoutMs", "--timeout"],
  ]) {
    if (input?.[key] !== undefined && input[key] !== "") args.push(flag, String(input[key]));
  }
  if (input?.enabled === true) args.push("--enabled");
  if (input?.enabled === false) args.push("--disabled");
  return runRoomJson("platform", args);
});

ipcMain.handle("room:platform-remove", (_event, id) => {
  const value = String(id || "").trim();
  if (!value) return { status: "error", summary: "平台 id 不能为空。" };
  return runRoomJson("platform", ["remove", "--id", value, "--json"]);
});

ipcMain.handle("room:doctor", (_event, roomId) => {
  const id = String(roomId || "").trim();
  const args = ["doctor", "--json"];
  if (id) args.push("--room", id);
  return runRoomJson("inspect", args);
});

ipcMain.handle("room:models-sync", async () => {
  const result = await spawnRoomCli("models", ["sync", "--data-dir", ROOM_DATA_DIR]);
  return {
    status: result.exitCode === 0 ? "success" : "error",
    summary: (result.stdout || result.stderr || "").trim(),
  };
});

ipcMain.handle("room:init", async (_event, input) => {
  const workspace = String(input?.workspace || APP_ROOT).trim() || APP_ROOT;
  const args = ["init", "--data-dir", ROOM_DATA_DIR, "--workspace", workspace];
  if (input?.real === true) {
    args.push("--real");
  }
  const result = await spawnRoomCli("init", args);
  return {
    status: result.exitCode === 0 ? "success" : "error",
    summary: (result.stdout || result.stderr || "").trim(),
  };
});

ipcMain.handle("room:update", async (_event, input) => {
  const roomId = String(input?.roomId || "").trim();
  const room = input?.room;
  if (!roomId || !room || typeof room !== "object" || room.id !== roomId) {
    return { status: "error", summary: "A room object with a matching id is required." };
  }
  const tmpDir = fs.mkdtempSync(path.join(USER_DATA_DIR, "room-update-"));
  const tmpFile = path.join(tmpDir, "room.json");
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(room, null, 2), "utf8");
    const result = await spawnRoomCli("update", [
      "--json-file", tmpFile,
      "--room", roomId,
      "--data-dir", ROOM_DATA_DIR,
    ]);
    return {
      status: result.exitCode === 0 ? "success" : "error",
      summary: (result.stdout || result.stderr || "").trim(),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle("room:run", async (_event, input) => {
  if (activeRoomRun) {
    return { status: "error", summary: "A room run is already active." };
  }
  const roomId = String(input?.roomId || "").trim();
  const prompt = String(input?.prompt || "").trim();
  if (!roomId || !prompt) {
    return { status: "error", summary: "Room id and prompt are required." };
  }
  const args = ["--json-events", "--data-dir", ROOM_DATA_DIR, "--room", roomId, "--prompt", prompt];
  if (input?.autonomy) {
    args.push("--autonomy", String(input.autonomy));
  }
  if (input?.maxHandoffs) {
    args.push("--max-handoffs", String(input.maxHandoffs));
  }
  if (input?.fake === true) {
    args.push("--fake");
  }
  for (const image of Array.isArray(input?.images) ? input.images : []) {
    args.push("--image", String(image));
  }
  if (input?.draft === true) {
    args.push("--draft");
    if (input?.runId) args.push("--run-id", String(input.runId));
    for (const scope of Array.isArray(input?.scope) ? input.scope : []) {
      args.push("--scope", String(scope));
    }
  }

  let stdoutBuffer = "";
  roomStopRequested = false;
  const result = await spawnRoomCli("run", args, {
    onChild: (child) => {
      activeRoomRun = child;
    },
    onStdout: (text) => {
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          mainWindow?.webContents.send("room:run-event", JSON.parse(trimmed));
        } catch {
          mainWindow?.webContents.send("room:run-log", trimmed);
        }
      }
    },
    onStderr: (text) => {
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        mainWindow?.webContents.send("room:run-log", line);
      }
    },
  });
  const stopped = roomStopRequested;
  activeRoomRun = null;
  roomStopRequested = false;
  if (stopped) {
    await spawnRoomCli("mark-stopped", [
      "--room", roomId,
      "--data-dir", ROOM_DATA_DIR,
      "--detail", "stopped from desktop",
    ]);
  }
  mainWindow?.webContents.send("room:run-finished", {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stopped,
  });
  return {
    status: stopped ? "success" : result.exitCode === 0 ? "success" : "error",
    exitCode: result.exitCode,
    stopped,
    stderr: result.stderr,
  };
});

ipcMain.handle("room:stop", () => {
  if (!activeRoomRun) {
    return { status: "warning", summary: "No active room run." };
  }
  roomStopRequested = true;
  const pid = activeRoomRun.pid;
  if (process.platform === "win32" && pid) {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    activeRoomRun.kill("SIGTERM");
  }
  activeRoomRun = null;
  return { status: "success", summary: "Stop signal sent." };
});

ipcMain.handle("room:open-room", () => {
  mainWindow?.loadFile(path.join(__dirname, "room.html"));
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (activeRun) {
    activeRun.kill("SIGTERM");
    activeRun = null;
  }
  if (activeRoomRun) {
    if (process.platform === "win32" && activeRoomRun.pid) {
      spawn("taskkill", ["/PID", String(activeRoomRun.pid), "/T", "/F"], { windowsHide: true });
    } else {
      activeRoomRun.kill("SIGTERM");
    }
    activeRoomRun = null;
  }
  app.quit();
});
