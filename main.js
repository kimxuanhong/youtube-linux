const { app, BrowserWindow, Tray, ipcMain, Notification, Menu, dialog, session } = require('electron')
const path = require('path')

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  appName: 'YouTube Music',
  appUrl: 'https://music.youtube.com/',
  partition: 'persist:youtube-music',
  devtools: process.env.YT_DEVTOOLS === '1',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iconPath: path.join(__dirname, 'icon.png'),
window: { width: 495, height: 1072, useContentSize: true },
}

// ─── State ────────────────────────────────────────────────────────────────────

let win = null
let tray = null
let isMuted = false

// ─── App bootstrap ────────────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', focusWindow)
  app.on('before-quit', () => {
    app.isQuiting = true
  })

  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

  app.whenReady().then(() => {
    app.userAgentFallback = CONFIG.userAgent

    const allowNotificationsOnly = (_, permission, callback) => callback(permission === 'notifications')
    session.defaultSession.setPermissionRequestHandler(allowNotificationsOnly)
    session.fromPartition(CONFIG.partition).setPermissionRequestHandler(allowNotificationsOnly)

    createWindow()
    createTray()
  })

  app.on('window-all-closed', (e) => e.preventDefault())
}

// ─── Window ───────────────────────────────────────────────────────────────────

function focusWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function createWindow() {
  win = new BrowserWindow({
    ...CONFIG.window,
    title: CONFIG.appName,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: true,
    autoHideMenuBar: true,
    menuBarVisible: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: CONFIG.partition,
      enableRemoteModule: true,
    },
  })

  win.webContents.setUserAgent(CONFIG.userAgent)
  win.setTitle(CONFIG.appName)
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    if (!win.isDestroyed()) win.setTitle(CONFIG.appName)
  })

  if (CONFIG.devtools) win.webContents.openDevTools()

  win.loadURL(CONFIG.appUrl)
  win.webContents.on('did-finish-load', hideScrollbars)
  win.webContents.on('did-navigate-in-page', hideScrollbars)

  win.once('ready-to-show', () => win.show())
  win.on('close', onClose)
}

function hideScrollbars() {
  if (!win || win.isDestroyed()) return
  win.webContents.insertCSS(`
    *::-webkit-scrollbar { display: none !important; }
    * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
  `).catch(() => {})
}

function onClose(e) {
  if (!app.isQuiting) {
    e.preventDefault()
    win.hide()
  }
}


function forceExitApp() {
  app.isQuiting = true
  app.exit(0)
}

function clearAppCache() {
  if (!win || win.isDestroyed()) return

  dialog.showMessageBox(win, {
    type: 'question',
    title: 'Clear Cache',
    message: 'Clear all cached data?',
    detail: 'This will clear thumbnails, images, and other cached content. Your login will be preserved.',
    buttons: ['Cancel', 'Clear Cache'],
    defaultId: 1,
    cancelId: 0,
  }).then(({ response }) => {
    if (response !== 1) return

    const ses = session.fromPartition(CONFIG.partition)
    // Chỉ xóa cache, KHÔNG xóa cookies/localStorage (giữ nguyên đăng nhập)
    Promise.all([
      ses.clearCache(),
      ses.clearStorageData({
        storages: ['appcache', 'filesystem', 'shadercache', 'serviceworkers', 'cachestorage'],
      }),
    ]).then(() => {
      win.webContents.reload()
    }).catch((err) => {
      console.error('Clear cache error:', err)
    })
  }).catch(() => {})
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(CONFIG.iconPath)
  tray.setToolTip(CONFIG.appName)
  tray.on('click', focusWindow)
  rebuildTrayMenu()
}

function refreshTrayMenu() {
  rebuildTrayMenu()
}

function setMuted(nextMuted) {
  isMuted = nextMuted
  if (win && !win.isDestroyed()) win.webContents.audioMuted = isMuted
  refreshTrayMenu()
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: focusWindow },
    { label: 'Back', accelerator: 'Alt+Left', click: () => win?.webContents.canGoBack() && win.webContents.goBack() },
    { label: 'Forward', accelerator: 'Alt+Right', click: () => win?.webContents.canGoForward() && win.webContents.goForward() },
    { label: 'Refresh', accelerator: 'F5', click: () => win?.webContents.reload() },
    { type: 'separator' },
    {
      label: isMuted ? 'Unmute' : 'Mute',
      accelerator: 'Alt+M',
      click: () => setMuted(!isMuted),
    },
    { type: 'separator' },
    { label: 'Clear Cache...', click: clearAppCache },
    { type: 'separator' },
    { label: 'Exit', click: forceExitApp },
  ])
  tray.setContextMenu(menu)
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('notify', (_, { title, body }) => {
  const notif = new Notification({ title, body, icon: CONFIG.iconPath })
  notif.on('click', focusWindow)
  notif.show()
})

ipcMain.on('badge', (_, count) => {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(count > 0 ? `${CONFIG.appName} (${count})` : CONFIG.appName)
  }
})
