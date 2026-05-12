import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Overlay } from './Overlay'
import { getSettings, type ApiDebuggerSettings } from '../shared/settings'
import { isExtensionContextValid } from '../shared/extensionGuard'
import { sendRuntimeMessage } from '../shared/sendMessage'
import { SettingsProvider, useUpdateSettings } from '../shared/SettingsContext'
import type { ReplayRequest, ReplayResult } from '../shared/types'

const replayRequests = new Map<string, (result: ReplayResult) => void>()
let settingsUpdater: ((s: ApiDebuggerSettings) => void) | null = null

export function App() {
  const updateSettings = useUpdateSettings()

  useEffect(() => {
    settingsUpdater = updateSettings
    return () => {
      settingsUpdater = null
    }
  }, [updateSettings])

  return <Overlay />
}

function postSettingsToPage(settings: ApiDebuggerSettings) {
  window.postMessage({
    source: 'api-debugger-content',
    type: 'API_DEBUGGER_SETTINGS',
    payload: settings,
  }, '*')
}

async function start() {
  let settings: ApiDebuggerSettings

  try {
    settings = await getSettings()
  } catch {
    return
  }

  // 1. Inject the fetch interceptor into page context
  const script = document.createElement('script')
  try {
    script.src = chrome.runtime.getURL('src/injected/index.js')
  } catch {
    return
  }
  script.onload = () => {
    postSettingsToPage(settings)
    script.remove()
  }
  ;(document.head ?? document.documentElement).prepend(script)

  // 2. Listen for messages from the injected script and forward to service worker
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.source !== 'api-debugger-injected') return

    if (event.data?.type === 'API_DEBUGGER_REPLAY_RESULT') {
      const resolve = replayRequests.get(event.data.requestId)
      if (resolve) {
        replayRequests.delete(event.data.requestId)
        resolve(event.data.payload as ReplayResult)
      }
      return
    }

    void sendRuntimeMessage(event.data)
  })

  if (isExtensionContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type !== 'EXECUTE_REPLAY') return false

        const requestId = crypto.randomUUID()
        const timeoutId = window.setTimeout(() => {
          const resolve = replayRequests.get(requestId)
          if (!resolve) return

          replayRequests.delete(requestId)
          resolve({
            status: 0,
            duration: 0,
            responseBody: 'Replay timed out.',
            responseHeaders: {},
          })
        }, 30000)

        replayRequests.set(requestId, result => {
          window.clearTimeout(timeoutId)
          sendResponse(result)
        })

        window.postMessage({
          source: 'api-debugger-content',
          type: 'API_DEBUGGER_REPLAY',
          requestId,
          payload: message.payload as ReplayRequest,
        }, '*')

        return true
      })
    } catch {
      // Ignore stale content scripts after extension reloads.
    }
  }

  // 3. Mount the overlay in a Shadow DOM to isolate styles from the host page
  const host = document.createElement('div')
  host.id = 'api-debugger-root'
  const shadow = host.attachShadow({ mode: 'open' })
  document.documentElement.appendChild(host)

  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)

  const root = createRoot(mountPoint)
  root.render(
    <SettingsProvider initialSettings={settings}>
      <App />
    </SettingsProvider>,
  )

  try {
    chrome.storage.onChanged.addListener((_changes, areaName) => {
      if (areaName !== 'local' && areaName !== 'sync') return

      getSettings().then(updated => {
        settings = updated
        postSettingsToPage(settings)
        settingsUpdater?.(settings)
      }).catch(() => {
        // Ignore stale content scripts after extension reloads.
      })
    })
  } catch {
    // Storage events are unavailable after an extension reload invalidates this script.
  }
}

start().catch(() => {
  // Keep stale dev-mode content scripts quiet after extension reloads.
})
