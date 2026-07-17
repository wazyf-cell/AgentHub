const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { parse } = require("url");

const DEFAULT_PORT = 1455;
const PORT = Number.parseInt(process.env.AGENT_SPACE_DESKTOP_PORT || "", 10) || DEFAULT_PORT;
const HOSTNAME = process.env.AGENT_SPACE_DESKTOP_HOSTNAME || "127.0.0.1";

const APP_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
const WEB_DIR = path.join(APP_ROOT, "apps", "web");
const LOG_FILE = path.join(app.getPath("userData"), "agent-space-desktop.log");
const APP_URL = `http://${HOSTNAME}:${PORT}`;

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never crash desktop startup.
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseDotEnv(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    let key = trimmed.slice(0, separatorIndex).trim();
    if (key.startsWith("export ")) {
      key = key.slice("export ".length).trim();
    }
    if (!key) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadDotEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  const values = parseDotEnv(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  log(`loaded env file: ${filePath}`);
  return true;
}

function loadRuntimeEnvironment() {
  const candidates = [
    process.env.AGENT_SPACE_ENV_FILE,
    path.join(process.cwd(), ".env"),
    path.join(APP_ROOT, ".env"),
    app.isPackaged ? path.join(process.resourcesPath, "app", ".env") : undefined,
    app.isPackaged ? path.join(path.dirname(process.execPath), ".env") : undefined,
  ];

  const seen = new Set();
  let loaded = false;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    loaded = loadDotEnvFile(resolved) || loaded;
  }

  process.env.AGENT_SPACE_APP_URL = APP_URL;
  process.env.AGENT_SPACE_REPOSITORY_ROOT = APP_ROOT;
  log(`runtime env loaded=${loaded} appRoot=${APP_ROOT} appUrl=${APP_URL}`);
}

function loadErrorPage(window, title, message) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 48px; line-height: 1.6; color: #111827; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    .box { max-width: 760px; border: 1px solid #e5e7eb; border-radius: 14px; padding: 24px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>日志文件：<code>${escapeHtml(LOG_FILE)}</code></p>
    <p>如果是开发环境，请先运行 <code>npm run build</code> 或使用 <code>npm run desktop:build</code>。</p>
  </div>
</body>
</html>`;

  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function assertProductionBuild() {
  const buildIdPath = path.join(WEB_DIR, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    throw new Error(`Next.js production build is missing: ${buildIdPath}`);
  }
}

function startEmbeddedNextServer() {
  assertProductionBuild();

  const localRequire = require("module").createRequire(path.join(WEB_DIR, "package.json"));
  const next = localRequire("next");
  const nextApp = next({
    dev: false,
    dir: WEB_DIR,
    hostname: "0.0.0.0",
    port: PORT,
  });

  let server = null;

  const ready = nextApp.prepare().then(() => {
    const handle = nextApp.getRequestHandler();
    server = http.createServer((request, response) => {
      handle(request, response, parse(request.url, true));
    });

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "0.0.0.0", () => {
        log(`embedded Next.js server listening on ${PORT}`);
        resolve();
      });
    });
  });

  return {
    ready,
    close() {
      if (server) {
        server.close();
        server = null;
      }
    },
  };
}

function waitForServer(url, timeoutMs = 60000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          log(`server ready check ok: ${url} status=${response.statusCode}`);
          resolve();
          return;
        }
        log(`server ready check retry: ${url} status=${response.statusCode}`);
        retry();
      });

      request.on("error", (error) => {
        log(`server ready check error: ${url} ${error.message}`);
        retry();
      });
      request.setTimeout(2000, () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(check, 800);
    };

    check();
  });
}

let mainWindow = null;
let embeddedServer = null;

async function createWindow() {
  loadRuntimeEnvironment();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: "AgentSpace",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  const healthUrl = `${APP_URL}/api/health`;

  try {
    embeddedServer = startEmbeddedNextServer();
    await embeddedServer.ready;
    await waitForServer(healthUrl);
    await mainWindow.loadURL(APP_URL);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    log(`desktop startup failed: ${message}`);
    loadErrorPage(mainWindow, "AgentSpace 启动失败", message);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (embeddedServer) {
    embeddedServer.close();
    embeddedServer = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  if (embeddedServer) {
    embeddedServer.close();
    embeddedServer = null;
  }
});
