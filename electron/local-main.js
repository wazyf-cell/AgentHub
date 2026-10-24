const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
const USER_DATA_DIR = app.getPath("userData");
const LOCAL_CONFIG_PATH = path.join(USER_DATA_DIR, "agentspace.local.json");
const LOCAL_OUTPUT_DIR = path.join(USER_DATA_DIR, "runs");
const LOG_FILE = path.join(USER_DATA_DIR, "agent-space-local-desktop.log");

let mainWindow = null;
let activeRun = null;

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
    title: "AgentSpace Local",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "local-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "local.html")).catch((error) => {
    log(`failed to load local UI: ${error.stack || error.message || String(error)}`);
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

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (activeRun) {
    activeRun.kill("SIGTERM");
    activeRun = null;
  }
  app.quit();
});
