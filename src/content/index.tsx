import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Overlay } from './Overlay'
import { DEFAULT_SETTINGS, getSettings, type ApiDebuggerSettings } from '../shared/settings'
import { isExtensionContextValid } from '../shared/extensionGuard'
import { sendRuntimeMessage } from '../shared/sendMessage'
import { SettingsProvider, useUpdateSettings } from '../shared/SettingsContext'
import type { OverlayStateSnapshot, ReplayRequest } from '../shared/types'

let settingsUpdater: ((s: ApiDebuggerSettings) => void) | null = null
const CONTENT_BOOTSTRAP_KEY = '__apiDebuggerContentBootstrap'

declare global {
  interface Window {
    __apiDebuggerContentBootstrap?: boolean
  }
}

interface InjectedBridgeConfig {
  replayEventType: string
  replayToken: string
}

export function App({ initialPaused }: { initialPaused: boolean }) {
  const updateSettings = useUpdateSettings()

  useEffect(() => {
    settingsUpdater = updateSettings
    return () => {
      settingsUpdater = null
    }
  }, [updateSettings])

  return <Overlay initialPaused={initialPaused} />
}

function postSettingsToPage(settings: ApiDebuggerSettings) {
  window.postMessage({
    source: 'api-debugger-content',
    type: 'API_DEBUGGER_SETTINGS',
    payload: settings,
  }, '*')
}

function createInjectedBridgeConfig(): InjectedBridgeConfig {
  return {
    replayEventType: `api-debugger:replay:${crypto.randomUUID()}`,
    replayToken: crypto.randomUUID(),
  }
}

function dispatchReplayToPage(
  bridgeConfig: InjectedBridgeConfig,
  requestId: string,
  payload: ReplayRequest,
) {
  document.documentElement.dispatchEvent(new CustomEvent(bridgeConfig.replayEventType, {
    detail: {
      token: bridgeConfig.replayToken,
      requestId,
      payload,
    },
  }))
}

function waitForDocumentElement() {
  if (document.documentElement) {
    return Promise.resolve(document.documentElement)
  }

  return new Promise<HTMLElement>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return

      observer.disconnect()
      resolve(document.documentElement)
    })

    observer.observe(document, {
      childList: true,
      subtree: true,
    })
  })
}

async function start() {
  try {
    await waitForDocumentElement()
  } catch {
    return
  }

  if (window[CONTENT_BOOTSTRAP_KEY]) {
    return
  }

  const existingHost = document.getElementById('api-debugger-root')
  if (existingHost?.shadowRoot) {
    // A stale host can remain after an extension reload; replace it so replay
    // listeners and the injected bridge are guaranteed to belong to this script instance.
    existingHost.remove()
  }

  let settings = DEFAULT_SETTINGS
  let initialPaused = false

  try {
    settings = await getSettings()
  } catch {
    // Fall back to defaults instead of skipping overlay startup entirely.
  }

  if (isExtensionContextValid()) {
    try {
      const snapshot = await chrome.runtime.sendMessage({ type: 'GET_OVERLAY_STATE' }) as OverlayStateSnapshot | undefined
      initialPaused = snapshot?.paused ?? false
    } catch {
      initialPaused = false
    }
  }

  // 1. Inject the fetch interceptor into page context
  const bridgeConfig = createInjectedBridgeConfig()
  const script = document.createElement('script')
  try {
    script.src = chrome.runtime.getURL('src/injected/index.js')
    script.dataset.apiDebuggerReplayEventType = bridgeConfig.replayEventType
    script.dataset.apiDebuggerReplayToken = bridgeConfig.replayToken
  } catch {
    return
  }
  window[CONTENT_BOOTSTRAP_KEY] = true
  script.onload = () => {
    postSettingsToPage(settings)
    script.remove()
  }
  ;(document.head ?? document.documentElement).prepend(script)

  // 2. Listen for messages from the injected script and forward to service worker
  let pageIsClosing = false
  window.addEventListener('pagehide', () => {
    pageIsClosing = true
  }, { capture: true })
  window.addEventListener('pageshow', () => {
    pageIsClosing = false
  }, { capture: true })

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.source !== 'api-debugger-injected') return
    if (pageIsClosing) return

    if (event.data?.type === 'API_DEBUGGER_REPLAY_RESULT') {
      void sendRuntimeMessage({
        type: 'REPLAY_PROGRESS',
        payload: {
          jobId: event.data.requestId,
          phase: 'complete',
          result: event.data.payload,
        },
      })
      return
    }

    if (event.data?.type === 'API_DEBUGGER_REPLAY_PROGRESS') {
      void sendRuntimeMessage({
        type: 'REPLAY_PROGRESS',
        payload: event.data.payload,
      })
      return
    }

    void sendRuntimeMessage(event.data)
  })

  if (isExtensionContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type !== 'EXECUTE_REPLAY') return false

        const replayRequest = message.payload as ReplayRequest
        const requestId = replayRequest.jobId ?? crypto.randomUUID()
        dispatchReplayToPage(bridgeConfig, requestId, replayRequest)
        sendResponse({ ok: true })
        return false
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
      <App initialPaused={initialPaused} />
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
