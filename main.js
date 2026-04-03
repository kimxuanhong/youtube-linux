const { app, BrowserWindow, Tray, ipcMain, Notification, Menu, session } = require('electron')
const path = require('path')

let win = null
let tray = null
let isMuted = false
let pipOnMinimize = true

const APP_NAME = 'YouTube'
const APP_URL = 'https://www.youtube.com/'
const APP_PARTITION = 'persist:youtube'
const ENABLE_DEVTOOLS = process.env.YT_DEVTOOLS === '1'

const CHROME_UA ='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('enable-features', 'PictureInPicture')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  // Keep video playing in background
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

  function createWindow() {
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        partition: APP_PARTITION,
        enableRemoteModule: true
      }
    })

    win.setMenu(null)
    win.webContents.setUserAgent(CHROME_UA)
    
    if (ENABLE_DEVTOOLS) {
      win.webContents.openDevTools()
    }
    
    win.loadURL(APP_URL)

    win.webContents.on('did-finish-load', injectNotificationInterceptor)
    win.webContents.on('did-navigate-in-page', injectNotificationInterceptor)

    win.once('ready-to-show', () => win.show())

    win.on('minimize', () => {
      if (pipOnMinimize) {
        win.webContents.executeJavaScript(`
          (function() {
            const events = [
              new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
              new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }),
              new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
            ]
            
            events.forEach(evt => document.documentElement.dispatchEvent(evt))
            
            setTimeout(() => {
              const video = document.querySelector('video')
              if (video && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
                video.requestPictureInPicture()
                  .then(() => {})
                  .catch(err => {})
              }
            }, 50)
          })()
        `).catch(err => {})
      }
    })

    win.on('restore', () => {
      win.webContents.executeJavaScript(`
        (function() {
          if (document.pictureInPictureElement) {
            document.exitPictureInPicture()
              .then(() => {})
              .catch(err => {})
          }
        })()
      `).catch(err => {})
    })

    win.on('close', (e) => {
      if (!app.isQuiting) {
        e.preventDefault()
        win.hide()
      }
    })
  }

  function injectNotificationInterceptor() {
    if (!win || win.isDestroyed()) return

    const script = `
      (function() {
        // Đảm bảo PiP luôn được báo cáo là có sẵn
        Object.defineProperty(document, 'pictureInPictureEnabled', {
          value: true,
          configurable: true
        });

        if (window.__youtubeNotifInjected) return;
        window.__youtubeNotifInjected = true;

        function YoutubeNotification(title, options) {
          options = options || {};
          if (window.youtubeLinux) {
            window.youtubeLinux.notify(title, options.body || '');
          }

          var self = this;
          self.title = title;
          self.body = options.body || '';
          self.icon = options.icon || '';
          self.tag = options.tag || '';
          self.close = function(){};
          self.addEventListener = function(){};
          self.removeEventListener = function(){};
          self.onclick = null;
          self.onclose = null;
          self.onerror = null;
          self.onshow = null;

          setTimeout(function() {
            if (typeof self.onshow === 'function') self.onshow();
          }, 10);
        }

        YoutubeNotification.permission = 'granted';
        YoutubeNotification.requestPermission = function(cb) {
          var p = Promise.resolve('granted');
          if (cb) cb('granted');
          return p;
        };
        YoutubeNotification.maxActions = 0;

        Object.defineProperty(window, 'Notification', {
          value: YoutubeNotification,
          writable: true,
          configurable: true
        });

        if (navigator.serviceWorker) {
          var origGetReg = navigator.serviceWorker.getRegistration;
          if (origGetReg) {
            navigator.serviceWorker.getRegistration = function() {
              return origGetReg.apply(this, arguments).then(function(reg) {
                if (reg && reg.showNotification) {
                  var origShow = reg.showNotification.bind(reg);
                  reg.showNotification = function(title, opts) {
                    opts = opts || {};
                    if (window.youtubeLinux) {
                      window.youtubeLinux.notify(title, opts.body || '');
                    }
                    return origShow(title, opts);
                  };
                }
                return reg;
              });
            };
          }
        }

        const injectPIP = () => {
          const video = document.querySelector('video');
          if (!video) {
            setTimeout(injectPIP, 1000);
            return;
          }

          video.disablePictureInPicture = false;

          // Tạo sự kiện để kích hoạt lại các nút điều khiển của YouTube nếu bị ẩn
          video.dispatchEvent(new Event('webkitbeginfullscreen'));
          video.dispatchEvent(new Event('webkitendfullscreen'));

          document.addEventListener('keydown', (e) => {
            if (e.key === 'p' || e.key === 'P') {
              if (video && document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(err => {});
              } else if (video) {
                video.requestPictureInPicture().catch(err => {});
              }
            }
          });
        };

        setTimeout(injectPIP, 1000);
      })();
    `

    win.webContents.executeJavaScript(script).catch((err) => {})
  }

  function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'))
    tray.setToolTip(APP_NAME)

    const updateTrayMenu = () => {
      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'Open',
          click: () => {
            if (win) {
              win.show()
              win.focus()
            }
          }
        },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            if (win && win.webContents.canGoBack()) {
              win.webContents.goBack()
            }
          }
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            if (win && win.webContents.canGoForward()) {
              win.webContents.goForward()
            }
          }
        },
        {
          label: 'Refresh',
          accelerator: 'F5',
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.reload()
            }
          }
        },
        { type: 'separator' },
        {
          label: isMuted ? 'Unmute' : 'Mute',
          accelerator: 'Alt+M',
          click: () => {
            if (win && !win.isDestroyed()) {
              isMuted = !isMuted
              win.webContents.audioMuted = isMuted
              updateTrayMenu()
            }
          }
        },
        { type: 'separator' },
        {
          label: pipOnMinimize ? '✓ PiP  (ON)' : '  PiP (OFF)',
          click: () => {
            pipOnMinimize = !pipOnMinimize
            updateTrayMenu()
          }
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => {
            app.isQuiting = true
            app.quit()
          }
        }
      ])
      tray.setContextMenu(contextMenu)
    }

    updateTrayMenu()

    tray.on('click', () => {
      if (win) {
        win.show()
        win.focus()
      }
    })
  }

  app.whenReady().then(() => {
    app.userAgentFallback = CHROME_UA

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true)
    })

    session.fromPartition(APP_PARTITION).setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true)
    })

    createWindow()
    createTray()
  })

  app.on('window-all-closed', (e) => {
    e.preventDefault()
  })
}

ipcMain.on('notify', (event, data) => {
  const notif = new Notification({
    title: data.title,
    body: data.body,
    icon: path.join(__dirname, 'icon.png')
  })

  notif.on('click', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })

  notif.show()
})

ipcMain.on('badge', (event, count) => {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(count > 0 ? `${APP_NAME} (${count})` : APP_NAME)
  }
})
