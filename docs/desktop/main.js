const path = require("path");
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { startServer } = require("./server");

let mainWindow = null;
let tray = null;
let port = 0;

function iconPath() {
  return path.join(__dirname, "villife.ico");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#12140f",
    title: "Villife",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#ffffff",
      height: 42
    },
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createTray() {
  let image = nativeImage.createFromPath(iconPath());
  if (process.platform === "darwin") image = image.resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("Villife");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Villife", click: () => mainWindow && mainWindow.show() },
      { label: "Check for updates", click: () => autoUpdater.checkForUpdatesAndNotify().catch(() => {}) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ])
  );
  tray.on("click", () => mainWindow && mainWindow.show());
}

app.whenReady().then(async () => {
  const started = await startServer();
  port = started.port;
  createWindow();
  createTray();
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(() => {});

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
