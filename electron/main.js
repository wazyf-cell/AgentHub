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
          resolve();
          return;
        }
        retry();
      });

      request.on("error", retry);
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

  const url = `http://${HOSTNAME}:${PORT}`;

  try {
    embeddedServer = startEmbeddedNextServer();
    await embeddedServer.ready;
    await waitForServer(url);
    await mainWindow.loadURL(url);
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
