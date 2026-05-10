import type { ReplayRequest, ReplayResult, ReplayTargetSnapshot, RequestEntry, SessionSnapshot } from '../shared/types'

// MV3 service worker - no DOM, no window object
// Central message hub and in-memory session store for the extension

const MAX_REQUESTS_PER_TAB = 100
const MAX_NETWORK_EVENTS_PER_TAB = 200
const NETWORK_MATCH_WINDOW_MS = 5000
const sessionsByTab = new Map<number, RequestEntry[]>()
const replayTargetsByTab = new Map<number, ReplayRequest>()
const requestReceivedAt = new Map<string, number>()
const networkEventsByTab = new Map<number, NetworkStatusEvent[]>()

interface NetworkStatusEvent {
  method: string
  url: string
  status: number
  observedAt: number
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('API Debugger installed successfully')
})

function getSession(tabId: number) {
  return sessionsByTab.get(tabId) ?? []
}

function normalizeRequestUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    parsedUrl.hash = ''
    return parsedUrl.href
  } catch {
    return url
  }
}

function getNetworkEvents(tabId: number) {
  return networkEventsByTab.get(tabId) ?? []
}

function publishSession(tabId: number) {
  chrome.runtime.sendMessage({
    type: 'SESSION_UPDATED',
    tabId,
    payload: getSession(tabId),
  }).catch(() => {
    // No extension page is currently listening.
  })
}

function rememberRequest(tabId: number, request: RequestEntry) {
  const receivedAt = Date.now()
  const networkEvent = findRecentNetworkEvent(tabId, request.method, request.url, receivedAt)
  const requestWithNetworkStatus = networkEvent && networkEvent.status !== request.status
    ? { ...request, status: networkEvent.status }
    : request
  const previousRequests = getSession(tabId)
  const requests = [...previousRequests, requestWithNetworkStatus].slice(-MAX_REQUESTS_PER_TAB)

  previousRequests
    .slice(0, Math.max(0, previousRequests.length + 1 - MAX_REQUESTS_PER_TAB))
    .forEach(entry => requestReceivedAt.delete(entry.id))

  requestReceivedAt.set(requestWithNetworkStatus.id, receivedAt)
  sessionsByTab.set(tabId, requests)
  publishSession(tabId)
}

function findRecentNetworkEvent(tabId: number, method: string, url: string, now = Date.now()) {
  const normalizedUrl = normalizeRequestUrl(url)
  const normalizedMethod = method.toUpperCase()

  return getNetworkEvents(tabId)
    .filter(event =>
      event.method === normalizedMethod &&
      event.url === normalizedUrl &&
      Math.abs(now - event.observedAt) <= NETWORK_MATCH_WINDOW_MS
    )
    .at(-1)
}

function rememberNetworkEvent(tabId: number, event: NetworkStatusEvent) {
  const events = [...getNetworkEvents(tabId), event].slice(-MAX_NETWORK_EVENTS_PER_TAB)
  networkEventsByTab.set(tabId, events)
  applyNetworkStatusToSession(tabId, event)
}

function applyNetworkStatusToSession(tabId: number, event: NetworkStatusEvent) {
  const requests = getSession(tabId)
  const matchIndex = requests.findLastIndex(request => {
    const receivedAt = requestReceivedAt.get(request.id)

    return (
      request.method.toUpperCase() === event.method &&
      normalizeRequestUrl(request.url) === event.url &&
      receivedAt != null &&
      Math.abs(event.observedAt - receivedAt) <= NETWORK_MATCH_WINDOW_MS
    )
  })

  if (matchIndex === -1 || requests[matchIndex].status === event.status) return

  const updatedRequest = { ...requests[matchIndex], status: event.status }
  const nextRequests = [...requests]
  nextRequests[matchIndex] = updatedRequest
  sessionsByTab.set(tabId, nextRequests)
  publishSession(tabId)

  chrome.tabs.sendMessage(tabId, {
    type: 'REQUEST_UPDATED',
    payload: updatedRequest,
  }).catch(() => {
    // Tab may have navigated or closed - safe to ignore
  })
}

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

async function getSessionSnapshot(tabId?: number): Promise<SessionSnapshot> {
  const resolvedTabId = tabId ?? await getActiveTabId()

  return {
    tabId: resolvedTabId,
    requests: resolvedTabId == null ? [] : getSession(resolvedTabId),
  }
}

async function getReplayTargetSnapshot(tabId?: number): Promise<ReplayTargetSnapshot> {
  const resolvedTabId = tabId ?? await getActiveTabId()

  return {
    tabId: resolvedTabId,
    request: resolvedTabId == null ? null : replayTargetsByTab.get(resolvedTabId) ?? null,
  }
}

function publishReplayTarget(tabId: number, request: ReplayRequest) {
  chrome.runtime.sendMessage({
    type: 'REPLAY_TARGET_SELECTED',
    tabId,
    payload: request,
  }).catch(() => {
    // No extension page is currently listening.
  })
}

chrome.tabs.onRemoved.addListener(tabId => {
  sessionsByTab.delete(tabId)
  replayTargetsByTab.delete(tabId)
  networkEventsByTab.delete(tabId)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return

  sessionsByTab.delete(tabId)
  replayTargetsByTab.delete(tabId)
  networkEventsByTab.delete(tabId)
  publishSession(tabId)
})

chrome.webRequest.onCompleted.addListener(details => {
  if (details.tabId < 0) return

  rememberNetworkEvent(details.tabId, {
    method: details.method.toUpperCase(),
    url: normalizeRequestUrl(details.url),
    status: details.statusCode,
    observedAt: Date.now(),
  })
}, {
  urls: ['<all_urls>'],
  types: ['xmlhttprequest'],
})

// Route messages from content scripts and extension pages.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SESSION') {
    getSessionSnapshot(message.tabId).then(sendResponse)
    return true
  }

  if (message.type === 'GET_REPLAY_TARGET') {
    getReplayTargetSnapshot(message.tabId).then(sendResponse)
    return true
  }

  if (message.type === 'RUN_REPLAY') {
    chrome.tabs.sendMessage(message.tabId, {
      type: 'EXECUTE_REPLAY',
      payload: message.payload,
    }).then((result: ReplayResult) => {
      sendResponse(result)
    }).catch(error => {
      sendResponse({
        status: 0,
        duration: 0,
        responseBody: String(error),
        responseHeaders: {},
      } satisfies ReplayResult)
    })
    return true
  }

  if (!sender.tab?.id) return false

  if (message.type === 'OPEN_SIDE_PANEL') {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {
      // Side panel open can fail if Chrome does not treat the source as a user gesture.
    })
    return false
  }

  if (message.type === 'SELECT_REPLAY') {
    replayTargetsByTab.set(sender.tab.id, message.payload)
    publishReplayTarget(sender.tab.id, message.payload)
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {
      // Side panel open can fail if Chrome does not treat the source as a user gesture.
    })
    return false
  }

  if (message.type === 'REQUEST_COMPLETE') {
    rememberRequest(sender.tab.id, message.payload)
    chrome.tabs.sendMessage(sender.tab.id, message).catch(() => {
      // Tab may have navigated or closed - safe to ignore
    })
    return false
  }

  if (message.type === 'REQUEST_FAILED') {
    chrome.tabs.sendMessage(sender.tab.id, message).catch(() => {
      // Tab may have navigated or closed - safe to ignore
    })
  }

  return false
})
