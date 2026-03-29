const { ipcRenderer, contextBridge } = require('electron')

contextBridge.exposeInMainWorld('youtubeLinux', {
  notify: (title, body) => {
    ipcRenderer.send('notify', { title, body })
  },
  badge: (count) => ipcRenderer.send('badge', count)
})

window.addEventListener('DOMContentLoaded', () => {
  setInterval(() => {
    const match = document.title.match(/\((\d+)\)/)
    const count = match ? parseInt(match[1], 10) : 0
    ipcRenderer.send('badge', count)
  }, 3000)
})
