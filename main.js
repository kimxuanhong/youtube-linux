const { app, BrowserWindow, Tray, ipcMain, Notification, Menu, dialog, session } = require('electron')
const path = require('path')
const pkg = require('./package.json')
const Player = require('mpris-service')

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  appName: 'YouTube',
  appUrl: 'https://www.youtube.com/',
  partition: 'persist:youtube',
  devtools: process.env.YT_DEVTOOLS === '1',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iconPath: path.join(__dirname, 'icon.png'),
  window: { width: 1200, height: 800 },
}

// ─── State ────────────────────────────────────────────────────────────────────

let win = null
let tray = null
let mprisPlayer = null
let mprisReconnectTimer = null
let isMuted = false
let pipOnMinimize = true

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
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService')
  app.commandLine.appendSwitch('enable-features', 'PictureInPicture')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

  app.whenReady().then(() => {
    app.userAgentFallback = CONFIG.userAgent

    const allowAllPermissions = (_, __, callback) => callback(true)
    session.defaultSession.setPermissionRequestHandler(allowAllPermissions)
    session.fromPartition(CONFIG.partition).setPermissionRequestHandler(allowAllPermissions)

    createApplicationMenu()
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: CONFIG.partition,
      enableRemoteModule: true,
    },
  })

  win.webContents.setUserAgent(CONFIG.userAgent)

  if (CONFIG.devtools) win.webContents.openDevTools()

  win.loadURL(CONFIG.appUrl)
  setupMPRIS()

  win.webContents.on('did-finish-load', injectPageScripts)
  win.webContents.on('did-navigate-in-page', injectPageScripts)
  win.once('ready-to-show', () => win.show())
  win.on('minimize', onMinimize)
  win.on('restore', onRestore)
  win.on('close', onClose)
}

function onMinimize() {
  if (!pipOnMinimize) return
  win.webContents.executeJavaScript(`
    (function () {
      const events = ['mousedown', 'mouseup', 'click'].map(
        type => new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
      )
      events.forEach(e => document.documentElement.dispatchEvent(e))

      setTimeout(() => {
        const video = document.querySelector('video')
        if (video && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
          video.requestPictureInPicture().catch(() => {})
        }
      }, 50)
    })()
  `).catch(() => { })
}

function onRestore() {
  win.webContents.executeJavaScript(`
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {})
    }
  `).catch(() => { })
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

function showAboutDialog() {
  const details = [
    pkg.description || 'Desktop wrapper for YouTube',
    '',
    `Version: ${pkg.version || app.getVersion()}`,
    `Author: ${pkg.author?.name || 'Unknown'}`,
    pkg.author?.email ? `Contact: ${pkg.author.email}` : null,
    pkg.homepage ? `Homepage: ${pkg.homepage}` : null,
  ].filter(Boolean).join('\n')

  dialog.showMessageBox({
    type: 'info',
    title: `About ${CONFIG.appName}`,
    message: CONFIG.appName,
    detail: details,
    icon: CONFIG.iconPath,
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  }).catch(() => { })
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: isMac ? 'File' : '&File',
      submenu: [
        { role: 'close' },
        { type: 'separator' },
        { label: 'Exit', click: forceExitApp },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: `About`, click: showAboutDialog },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── Page script injection ────────────────────────────────────────────────────

function injectPageScripts() {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(PAGE_SCRIPT).catch(() => { })
}

// Injected into the renderer. Runs once per navigation; sets up:
//   • PiP availability override
//   • Periodic MPRIS metadata sync
//   • Native Notification shim (routes to Electron)
//   • PiP keyboard shortcut (P key)
const PAGE_SCRIPT = `
(function () {
  // Always report PiP as available
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true })

  const runtime = window.__ytLinuxRuntime || (window.__ytLinuxRuntime = {})
  if (window.__ytLinuxInjected) return
  window.__ytLinuxInjected = true

  // ── MPRIS metadata sync ────────────────────────────────────────────────────

  // Cache so we don't re-probe the same video ID on every 2s tick.
  let _artUrlCache = { id: null, url: 'https://www.youtube.com/favicon.ico' }

  // Extract the current video ID from the URL (works after SPA navigation too).
  function currentVideoId() {
    try { return new URL(location.href).searchParams.get('v') || null } catch (_) { return null }
  }

  // i.ytimg.com thumbnails are the only source that:
  //   • always reflects the CURRENT video (keyed by video ID in the URL)
  //   • survives SPA navigation without stale globals
  //   • never requires waiting for mediaSession to be populated
  //
  // Resolution ladder: maxresdefault (1280×720) → hqdefault (480×360, always exists).
  // We probe maxres once per video ID using a hidden Image, then cache the result.
  function resolveArtUrl(videoId) {
    if (!videoId) return 'https://www.youtube.com/favicon.ico'

    // nếu đã resolve rồi thì dùng luôn
    if (_artUrlCache.id === videoId && _artUrlCache.url) {
      return _artUrlCache.url
    }

    const max = 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg'
    const hq  = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg'

    // 👉 mặc định dùng maxres luôn
    _artUrlCache = { id: videoId, url: max }

    // 👉 kiểm tra ngầm, nếu maxres là fake thì fallback
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth <= 120) {
        _artUrlCache = { id: videoId, url: hq }
      }
    }
    img.onerror = () => {
      _artUrlCache = { id: videoId, url: hq }
    }
    img.src = max

    return max
  }

  function syncMPRIS() {
    if (!window.youtubeLinux?.mprisUpdate) return

    const video   = document.querySelector('video')
    const ms      = navigator.mediaSession?.metadata
    const videoId = currentVideoId()

    window.youtubeLinux.mprisUpdate({
      title:    ms?.title || document.title.replace(/\s*[-–]\s*YouTube\s*$/, '').trim() || 'YouTube',
      artist:   ms?.artist
                  || document.querySelector('ytd-video-owner-renderer #channel-name a, #channel-name a')?.textContent?.trim()
                  || 'YouTube',
      artUrl:   resolveArtUrl(videoId),
      duration: video && !isNaN(video.duration)    ? Math.floor(video.duration)    : 0,
      position: video && !isNaN(video.currentTime) ? Math.floor(video.currentTime) : 0,
      paused:   video ? video.paused : true,
    })
  }

  if (runtime.mprisInterval) clearInterval(runtime.mprisInterval)
  runtime.mprisInterval = setInterval(syncMPRIS, 2000)

  // Also sync immediately on video src change (catches SPA navigation faster than the 2s tick).
  if (!runtime.playPatched) {
    runtime.originalHtmlMediaPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      // Reset art cache so the next syncMPRIS call re-probes for the new video.
      _artUrlCache = { id: null, url: 'https://www.youtube.com/favicon.ico' }
      return runtime.originalHtmlMediaPlay.apply(this, arguments)
    }
    runtime.playPatched = true
  }

  // ── Notification shim ──────────────────────────────────────────────────────

  function YoutubeNotification(title, options = {}) {
    window.youtubeLinux?.notify(title, options.body || '')
    Object.assign(this, { title, body: options.body || '', icon: options.icon || '',
      tag: options.tag || '', close() {}, addEventListener() {}, removeEventListener() {},
      onclick: null, onclose: null, onerror: null, onshow: null })
    setTimeout(() => typeof this.onshow === 'function' && this.onshow(), 10)
  }

  YoutubeNotification.permission = 'granted'
  YoutubeNotification.requestPermission = (cb) => {
    if (cb) cb('granted')
    return Promise.resolve('granted')
  }
  YoutubeNotification.maxActions = 0

  Object.defineProperty(window, 'Notification', { value: YoutubeNotification, writable: true, configurable: true })

  // Patch service-worker notifications too
  const origGetReg = navigator.serviceWorker?.getRegistration
  if (origGetReg) {
    navigator.serviceWorker.getRegistration = function (...args) {
      return origGetReg.apply(this, args).then(reg => {
        if (reg?.showNotification) {
          const orig = reg.showNotification.bind(reg)
          reg.showNotification = (title, opts = {}) => {
            window.youtubeLinux?.notify(title, opts.body || '')
            return orig(title, opts)
          }
        }
        return reg
      })
    }
  }

  // ── PiP setup ─────────────────────────────────────────────────────────────

  function setupPiP() {
    if (runtime.cleanupPiP) runtime.cleanupPiP()

    let activeVideo = null
    let overlay = null
    let hideOverlayTimer = null
    let isVideoHovered = false
    let isOverlayHovered = false

    function isPiPSupported(video) {
      return !!(
        video &&
        document.pictureInPictureEnabled &&
        !video.disablePictureInPicture
      )
    }

    function clearHideTimer() {
      if (!hideOverlayTimer) return
      clearTimeout(hideOverlayTimer)
      hideOverlayTimer = null
    }

    function scheduleOverlayHide() {
      clearHideTimer()
      hideOverlayTimer = setTimeout(() => {
        if (!overlay || isVideoHovered || isOverlayHovered) return
        overlay.style.opacity = '0'
        overlay.style.pointerEvents = 'none'
      }, 160)
    }

    function ensureOverlay() {
      if (overlay?.isConnected) return overlay

      overlay = document.createElement('button')
      overlay.type = 'button'
      overlay.setAttribute('aria-label', 'Picture in Picture')
      overlay.textContent = 'PiP'
      Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '36px',
        minWidth: '52px',
        padding: '0 12px',
        border: '1px solid rgba(255, 255, 255, 0.22)',
        borderRadius: '999px',
        background: 'rgba(15, 15, 15, 0.82)',
        color: '#fff',
        font: '600 13px system-ui, sans-serif',
        letterSpacing: '0.02em',
        cursor: 'pointer',
        boxShadow: '0 10px 24px rgba(0, 0, 0, 0.28)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        opacity: '0',
        transform: 'translateY(0)',
        transition: 'opacity 140ms ease, transform 140ms ease',
        pointerEvents: 'none',
      })

      overlay.addEventListener('mouseenter', () => {
        isOverlayHovered = true
        clearHideTimer()
      })
      overlay.addEventListener('mouseleave', () => {
        isOverlayHovered = false
        scheduleOverlayHide()
      })
      overlay.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!activeVideo || !isPiPSupported(activeVideo)) return

        const action = document.pictureInPictureElement === activeVideo
          ? document.exitPictureInPicture()
          : activeVideo.requestPictureInPicture()

        action.catch(() => {})
      })

      document.documentElement.appendChild(overlay)
      return overlay
    }

    function updateOverlayLabel() {
      if (!overlay) return
      const isActive = document.pictureInPictureElement === activeVideo
      overlay.setAttribute('aria-label', isActive ? 'Exit Picture in Picture' : 'Picture in Picture')
      overlay.textContent = isActive ? 'Exit PiP' : 'PiP'
    }

    function positionOverlay(video) {
      const button = ensureOverlay()
      const rect = video.getBoundingClientRect()
      const minWidth = 220
      const minHeight = 124

      if (
        rect.width < minWidth ||
        rect.height < minHeight ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= window.innerHeight ||
        rect.left >= window.innerWidth
      ) {
        button.style.opacity = '0'
        button.style.pointerEvents = 'none'
        return
      }

      const top = Math.max(12, rect.top + 16)
      const left = Math.max(12, rect.right - button.offsetWidth - 16)
      button.style.top = top + 'px'
      button.style.left = left + 'px'
      button.style.opacity = '1'
      button.style.pointerEvents = 'auto'
      updateOverlayLabel()
    }

    function attachToVideo(video) {
      if (!video || video === activeVideo) return

      if (activeVideo) {
        activeVideo.removeEventListener('mouseenter', handleVideoEnter)
        activeVideo.removeEventListener('mousemove', handleVideoMove)
        activeVideo.removeEventListener('mouseleave', handleVideoLeave)
      }

      activeVideo = video
      activeVideo.disablePictureInPicture = false
      activeVideo.dispatchEvent(new Event('webkitbeginfullscreen'))
      activeVideo.dispatchEvent(new Event('webkitendfullscreen'))
      activeVideo.addEventListener('mouseenter', handleVideoEnter)
      activeVideo.addEventListener('mousemove', handleVideoMove)
      activeVideo.addEventListener('mouseleave', handleVideoLeave)
      updateOverlayLabel()
    }

    function findVideo() {
      const candidates = Array.from(document.querySelectorAll('video'))
      return candidates.find((video) => video.offsetWidth > 0 && video.offsetHeight > 0) || candidates[0] || null
    }

    function handleVideoEnter(event) {
      const video = event.currentTarget
      if (!isPiPSupported(video)) return
      isVideoHovered = true
      clearHideTimer()
      positionOverlay(video)
    }

    function handleVideoMove(event) {
      const video = event.currentTarget
      if (!isPiPSupported(video)) return
      if (event.buttons) return
      isVideoHovered = true
      positionOverlay(video)
    }

    function handleVideoLeave() {
      isVideoHovered = false
      scheduleOverlayHide()
    }

    function handleKeyDown(e) {
      if (e.key !== 'p' && e.key !== 'P') return
      refreshVideoBinding()
      if (!activeVideo || !isPiPSupported(activeVideo)) return
      document.pictureInPictureElement
        ? document.exitPictureInPicture().catch(() => {})
        : activeVideo.requestPictureInPicture().catch(() => {})
    }

    function handleViewportChange() {
      if ((isVideoHovered || isOverlayHovered) && activeVideo) positionOverlay(activeVideo)
    }

    function refreshVideoBinding() {
      attachToVideo(findVideo())
      if (document.pictureInPictureElement && overlay && document.pictureInPictureElement !== activeVideo) {
        overlay.style.opacity = '0'
        overlay.style.pointerEvents = 'none'
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('enterpictureinpicture', updateOverlayLabel, true)
    document.addEventListener('leavepictureinpicture', updateOverlayLabel, true)
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)

    const observer = new MutationObserver(refreshVideoBinding)
    observer.observe(document.documentElement, { childList: true, subtree: true })

    refreshVideoBinding()
    const refreshVideoBindingInterval = setInterval(refreshVideoBinding, 1500)

    runtime.cleanupPiP = () => {
      clearHideTimer()
      clearInterval(refreshVideoBindingInterval)
      observer.disconnect()
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('enterpictureinpicture', updateOverlayLabel, true)
      document.removeEventListener('leavepictureinpicture', updateOverlayLabel, true)
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)

      if (activeVideo) {
        activeVideo.removeEventListener('mouseenter', handleVideoEnter)
        activeVideo.removeEventListener('mousemove', handleVideoMove)
        activeVideo.removeEventListener('mouseleave', handleVideoLeave)
      }

      if (overlay?.isConnected) overlay.remove()
      runtime.cleanupPiP = null
    }
  }

  if (runtime.pipSetupTimer) clearTimeout(runtime.pipSetupTimer)
  runtime.pipSetupTimer = setTimeout(() => {
    runtime.pipSetupTimer = null
    setupPiP()
  }, 1000)
})()
`

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

function togglePiPOnMinimize() {
  pipOnMinimize = !pipOnMinimize
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
    {
      label: pipOnMinimize ? 'PiP (ON)' : 'PiP (OFF)',
      click: togglePiPOnMinimize,
    },
    { type: 'separator' },
    { label: 'Exit', click: forceExitApp },
  ])
  tray.setContextMenu(menu)
}

// ─── MPRIS ────────────────────────────────────────────────────────────────────

function destroyMPRIS() {
  if (!mprisPlayer) return
  try { mprisPlayer._bus?.disconnect() } catch (_) { }
  mprisPlayer = null
}

function scheduleReconnect() {
  if (app.isQuiting) return
  mprisReconnectTimer = setTimeout(setupMPRIS, 3000)
}

function setupMPRIS() {
  if (mprisReconnectTimer) { clearTimeout(mprisReconnectTimer); mprisReconnectTimer = null }

  try {
    mprisPlayer = new Player({ name: 'youtube', identity: 'YouTube', supportedInterfaces: ['player'] })
    mprisPlayer.desktopEntry = 'youtube-linux'

    mprisPlayer.on('error', (err) => {
      const msg = err?.message ?? ''
      const isStreamClosed = msg.includes('closed stream') || msg.includes('stream is closed')
      if (!isStreamClosed) console.error('MPRIS error:', err)
      destroyMPRIS()
      scheduleReconnect()
    })

    const js = (code) => win?.webContents.executeJavaScript(code).catch(() => { })
    const key = (keyCode, modifiers) => win?.webContents.sendInputEvent({ type: 'keyDown', keyCode, ...(modifiers && { modifiers }) })

    mprisPlayer.on('playpause', () => key('k'))
    mprisPlayer.on('next', () => key('n', ['shift']))
    mprisPlayer.on('previous', () => js('window.history.back()'))
    mprisPlayer.on('play', () => js('document.querySelector("video")?.play()'))
    mprisPlayer.on('pause', () => js('document.querySelector("video")?.pause()'))
  } catch (e) {
    console.error('MPRIS setup error:', e)
    mprisPlayer = null
    scheduleReconnect()
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('mpris-update', (_, data) => {
  if (!mprisPlayer) return
  try {
    mprisPlayer.playbackStatus = data.paused ? 'Paused' : 'Playing'
    mprisPlayer.metadata = {
      'mpris:trackid': mprisPlayer.objectPath('track/0'),
      'xesam:title': data.title || 'YouTube',
      'xesam:artist': [data.artist || 'YouTube'],
      'mpris:artUrl': data.artUrl || 'https://www.youtube.com/favicon.ico',
      'mpris:length': data.duration ? data.duration * 1_000_000 : 0,
    }
  } catch (e) {
    const msg = e?.message ?? ''
    if (msg.includes('closed stream') || msg.includes('stream is closed')) {
      mprisPlayer = null
    } else {
      console.error('MPRIS metadata error:', e)
    }
  }
})

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
