import React from 'react'
import { createRoot } from 'react-dom/client'
import { Overlay } from './Overlay'

// 1. Inject the fetch interceptor into page context
const script = document.createElement('script')
script.src = chrome.runtime.getURL('src/injected/index.js')
script.onload = () => script.remove()
;(document.head ?? document.documentElement).prepend(script)

// 2. Listen for messages from the injected script and forward to service worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if (event.data?.source !== 'api-debugger-injected') return
  chrome.runtime.sendMessage(event.data)
})

// 3. Mount the overlay in a Shadow DOM to isolate styles from the host page
const host = document.createElement('div')
host.id = 'api-debugger-root'
const shadow = host.attachShadow({ mode: 'open' })
document.documentElement.appendChild(host)

const mountPoint = document.createElement('div')
shadow.appendChild(mountPoint)

createRoot(mountPoint).render(<Overlay />)
