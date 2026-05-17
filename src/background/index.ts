import type {
  AISuggestionRequest,
  AISuggestionResponse,
  ReplayRequest,
  ReplayResult,
  ReplayTargetSnapshot,
  RequestEntry,
  SessionSnapshot,
  TimingSource,
  TimingUpdatePayload,
} from '../shared/types'
import { getSettings } from '../shared/settings'

// MV3 service worker - no DOM, no window object
// Central message hub and in-memory session store for the extension

const MAX_REQUESTS_PER_TAB = 100
const MAX_NETWORK_EVENTS_PER_TAB = 200
const NETWORK_MATCH_WINDOW_MS = 5000
const PENDING_REQUEST_FALLBACK_MS = 1000
const PENDING_REQUEST_CLEANUP_MS = 5000
const CDP_MATCH_WINDOW_MS = 5000
const AI_RATE_LIMIT_MS = 10000
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const AI_MODEL = 'claude-sonnet-4-20250514'
const AI_TEST_MODEL = 'claude-haiku-4-5-20251001'
const sessionsByTab = new Map<number, RequestEntry[]>()
const duplicateGroupsByTab = new Map<number, Map<string, DuplicateGroup>>()
const replayTargetsByTab = new Map<number, ReplayRequest>()
const requestReceivedAt = new Map<string, number>()
const networkEventsByTab = new Map<number, NetworkStatusEvent[]>()
const pendingRequestsByTab = new Map<number, Map<string, PendingRequestState>>()
const attachedDebuggerTabs = new Set<number>()
const cdpRequestsByTab = new Map<number, Map<string, CdpRequestState>>()
let lastAiRequestAt = 0

interface NetworkStatusEvent {
  method: string
  url: string
  status: number
  observedAt: number
}

interface DuplicateGroup {
  firstRequestId: string
  count: number
}

interface PendingRequestState {
  proxy?: RequestEntry
  timing?: TimingUpdatePayload
  flushTimeoutId?: number
  cleanupTimeoutId?: number
}

interface CdpTimingData {
  requestTime: number
  dnsStart: number
  dnsEnd: number
  connectStart: number
  connectEnd: number
  sslStart: number
  sslEnd: number
  sendStart: number
  sendEnd: number
  receiveHeadersEnd: number
}

interface CdpRequestState {
  requestId: string
  url: string
  method: string
  wallTime: number
  sentAt: number
  matchedRequestId?: string
  status?: number
  timing?: CdpTimingData
  encodedDataLength?: number
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('API Debugger installed successfully')
})

function getSession(tabId: number) {
  return sessionsByTab.get(tabId) ?? []
}

function getPendingRequests(tabId: number) {
  let pending = pendingRequestsByTab.get(tabId)
  if (!pending) {
    pending = new Map()
    pendingRequestsByTab.set(tabId, pending)
  }

  return pending
}

function getCdpRequests(tabId: number) {
  let requests = cdpRequestsByTab.get(tabId)
  if (!requests) {
    requests = new Map()
    cdpRequestsByTab.set(tabId, requests)
  }

  return requests
}

function getDuplicateGroups(tabId: number) {
  let groups = duplicateGroupsByTab.get(tabId)
  if (!groups) {
    groups = new Map()
    duplicateGroupsByTab.set(tabId, groups)
  }

  return groups
}

function normalizeRequestUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    parsedUrl.hash = ''
    parsedUrl.searchParams.sort()
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

function urlsLooselyMatch(left: string, right: string) {
  const normalizedLeft = normalizeRequestUrl(left)
  const normalizedRight = normalizeRequestUrl(right)
  if (normalizedLeft === normalizedRight) return true

  try {
    const leftUrl = new URL(normalizedLeft)
    const rightUrl = new URL(normalizedRight)
    return leftUrl.pathname === rightUrl.pathname
  } catch {
    return normalizedLeft === normalizedRight
  }
}

function clearPendingRequest(tabId: number, requestId: string) {
  const pending = pendingRequestsByTab.get(tabId)
  const state = pending?.get(requestId)

  if (state?.flushTimeoutId != null) {
    clearTimeout(state.flushTimeoutId)
  }
  if (state?.cleanupTimeoutId != null) {
    clearTimeout(state.cleanupTimeoutId)
  }

  pending?.delete(requestId)
  if (pending?.size === 0) {
    pendingRequestsByTab.delete(tabId)
  }
}

function clearAllPendingRequests(tabId: number) {
  const pending = pendingRequestsByTab.get(tabId)
  if (!pending) return

  for (const requestId of pending.keys()) {
    clearPendingRequest(tabId, requestId)
  }
}

function schedulePendingCleanup(tabId: number, requestId: string, state: PendingRequestState) {
  if (state.cleanupTimeoutId != null) return

  state.cleanupTimeoutId = setTimeout(() => {
    clearPendingRequest(tabId, requestId)
  }, PENDING_REQUEST_CLEANUP_MS) as unknown as number
}

function mergeRequestTiming(proxy: RequestEntry, timing?: TimingUpdatePayload): RequestEntry {
  if (!timing) return proxy

  const timingSource: TimingSource = timing.timingSource === 'cdp'
    ? 'cdp'
    : timing.duration > 0
      ? 'performance'
      : proxy.timingSource

  return {
    ...proxy,
    duration: timing.duration > 0 ? timing.duration : proxy.duration,
    startTime: timing.startTime > 0 ? timing.startTime : proxy.startTime,
    responseSize: timing.responseSize > 0 ? timing.responseSize : proxy.responseSize,
    decodedBodySize: timing.decodedBodySize > 0 ? timing.decodedBodySize : proxy.decodedBodySize,
    transferSize: timing.transferSize > 0 ? timing.transferSize : proxy.transferSize,
    ttfb: timing.ttfb > 0 ? timing.ttfb : proxy.ttfb,
    dnsTime: timing.dnsTime > 0 ? timing.dnsTime : proxy.dnsTime,
    connectTime: timing.connectTime > 0 ? timing.connectTime : proxy.connectTime,
    sslTime: timing.sslTime > 0 ? timing.sslTime : proxy.sslTime,
    requestTime: timing.requestTime > 0 ? timing.requestTime : proxy.requestTime,
    responseTime: timing.responseTime > 0 ? timing.responseTime : proxy.responseTime,
    timingSource,
  }
}

function updateStoredRequestTiming(tabId: number, timing: TimingUpdatePayload) {
  const requests = getSession(tabId)
  const matchIndex = requests.findIndex(request => request.id === timing.id)
  if (matchIndex === -1) return false

  const updatedRequest = mergeRequestTiming(requests[matchIndex], timing)
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

  return true
}

function flushPendingRequest(tabId: number, requestId: string) {
  const pending = pendingRequestsByTab.get(tabId)
  const state = pending?.get(requestId)

  if (!state?.proxy) return

  const mergedRequest = mergeRequestTiming(state.proxy, state.timing)
  clearPendingRequest(tabId, requestId)

  const { request, updatedRequests } = rememberRequest(tabId, mergedRequest)
  updatedRequests.forEach(updatedRequest => {
    chrome.tabs.sendMessage(tabId, {
      type: 'REQUEST_UPDATED',
      payload: updatedRequest,
    }).catch(() => {
      // Tab may have navigated or closed - safe to ignore
    })
  })
  chrome.tabs.sendMessage(tabId, {
    type: 'REQUEST_COMPLETE',
    payload: request,
  }).catch(() => {
    // Tab may have navigated or closed - safe to ignore
  })
}

function findBestCdpMatch(tabId: number, proxyRequest: RequestEntry) {
  let bestMatch: CdpRequestState | null = null
  let bestDelta = Number.POSITIVE_INFINITY

  for (const cdpRequest of getCdpRequests(tabId).values()) {
    if (cdpRequest.matchedRequestId && cdpRequest.matchedRequestId !== proxyRequest.id) continue
    if (cdpRequest.method !== proxyRequest.method.toUpperCase()) continue
    if (!urlsLooselyMatch(cdpRequest.url, proxyRequest.url)) continue

    const delta = Math.abs(cdpRequest.wallTime - proxyRequest.startTime)
    if (delta > CDP_MATCH_WINDOW_MS) continue

    if (delta < bestDelta) {
      bestDelta = delta
      bestMatch = cdpRequest
    }
  }

  return bestMatch
}

function buildCdpTimingPayload(requestId: string, cdpRequest: CdpRequestState): TimingUpdatePayload | null {
  if (!cdpRequest.timing) return null

  const timing = cdpRequest.timing
  const duration = cdpRequest.encodedDataLength != null
    ? Math.max(0, Math.round((cdpRequest.sentAt - timing.requestTime) * 1000))
    : 0

  return {
    id: requestId,
    url: cdpRequest.url,
    duration: duration > 0 ? duration : Math.max(0, Math.round(timing.receiveHeadersEnd)),
    startTime: cdpRequest.wallTime,
    ttfb: timing.receiveHeadersEnd > 0 && timing.sendEnd >= 0
      ? Math.max(0, Math.round(timing.receiveHeadersEnd - timing.sendEnd))
      : 0,
    dnsTime: timing.dnsEnd >= 0 && timing.dnsStart >= 0
      ? Math.max(0, Math.round(timing.dnsEnd - timing.dnsStart))
      : 0,
    connectTime: timing.connectEnd >= 0 && timing.connectStart >= 0
      ? Math.max(0, Math.round(timing.connectEnd - timing.connectStart))
      : 0,
    sslTime: timing.sslEnd >= 0 && timing.sslStart >= 0
      ? Math.max(0, Math.round(timing.sslEnd - timing.sslStart))
      : 0,
    requestTime: timing.receiveHeadersEnd > 0 && timing.sendEnd >= 0
      ? Math.max(0, Math.round(timing.receiveHeadersEnd - timing.sendEnd))
      : 0,
    responseTime: 0,
    responseSize: cdpRequest.encodedDataLength ?? 0,
    decodedBodySize: 0,
    transferSize: cdpRequest.encodedDataLength ?? 0,
    timingSource: 'cdp',
  }
}

function queueRequestCompletion(tabId: number, proxyRequest: RequestEntry) {
  const matchedCdpRequest = findBestCdpMatch(tabId, proxyRequest)
  if (matchedCdpRequest) {
    matchedCdpRequest.matchedRequestId = proxyRequest.id
    const cdpTimingPayload = buildCdpTimingPayload(proxyRequest.id, matchedCdpRequest)
    if (cdpTimingPayload) {
      queueTimingUpdate(tabId, cdpTimingPayload)
    }
  }

  const pending = getPendingRequests(tabId)
  const state = pending.get(proxyRequest.id) ?? {}
  state.proxy = proxyRequest

  if (state.flushTimeoutId != null) {
    clearTimeout(state.flushTimeoutId)
  }

  if (state.timing) {
    pending.set(proxyRequest.id, state)
    flushPendingRequest(tabId, proxyRequest.id)
    return
  }

  state.flushTimeoutId = setTimeout(() => {
    flushPendingRequest(tabId, proxyRequest.id)
  }, PENDING_REQUEST_FALLBACK_MS) as unknown as number

  pending.set(proxyRequest.id, state)
  schedulePendingCleanup(tabId, proxyRequest.id, state)
}

function queueTimingUpdate(tabId: number, timing: TimingUpdatePayload) {
  const pending = getPendingRequests(tabId)
  const state = pending.get(timing.id) ?? {}
  state.timing = timing
  pending.set(timing.id, state)
  schedulePendingCleanup(tabId, timing.id, state)

  if (state.proxy) {
    flushPendingRequest(tabId, timing.id)
    return
  }

  updateStoredRequestTiming(tabId, timing)
}

async function attachDebugger(tabId: number) {
  if (attachedDebuggerTabs.has(tabId)) return

  await chrome.debugger.attach({ tabId }, '1.3')
  attachedDebuggerTabs.add(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxTotalBufferSize: 1000000,
    maxResourceBufferSize: 1000000,
  })
}

async function detachDebugger(tabId: number) {
  if (!attachedDebuggerTabs.has(tabId)) return

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // Tab may already be gone or detached.
  } finally {
    attachedDebuggerTabs.delete(tabId)
    cdpRequestsByTab.delete(tabId)
  }
}

async function setPreciseMode(enabled: boolean) {
  const tabId = await getActiveTabId()
  if (tabId == null) return

  if (enabled) {
    await attachDebugger(tabId)
  } else {
    await detachDebugger(tabId)
  }
}

function sanitizeUrlForAi(url: string) {
  try {
    const parsedUrl = new URL(url)
    parsedUrl.hash = ''

    const sanitizedPath = parsedUrl.pathname
      .split('/')
      .map(segment => {
        if (/^\d+$/.test(segment)) return ':id'
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':uuid'
        if (/^[0-9a-f]{16,}$/i.test(segment)) return ':hash'
        return segment
      })
      .join('/')

    const sanitizedParams = new URLSearchParams()
    parsedUrl.searchParams.forEach((value, key) => {
      if (/token|key|secret|password|auth|session/i.test(key)) return
      if (/^\d+$/.test(value)) {
        sanitizedParams.set(key, ':id')
        return
      }
      if (value.length > 80) {
        sanitizedParams.set(key, ':value')
        return
      }
      sanitizedParams.set(key, value)
    })

    parsedUrl.pathname = sanitizedPath
    parsedUrl.search = sanitizedParams.toString()
    return parsedUrl.href
  } catch {
    return url
      .replace(/\/\d+/g, '/:id')
      .replace(/[?&][^=]*(token|key|secret|password|auth|session)[^=]*=[^&]*/gi, '')
  }
}

export function buildAiSuggestionPrompt(request: AISuggestionRequest) {
  const sanitizedUrl = sanitizeUrlForAi(request.url)

  return [
    `An API request was flagged as ${request.isSlow ? 'slow' : 'failed'}.`,
    `Method: ${request.method}`,
    `Endpoint: ${sanitizedUrl}`,
    `Status: ${request.status}`,
    `Duration: ${request.duration}ms`,
    `TTFB: ${request.ttfb}ms`,
    `Response size: ${request.responseSize} bytes`,
    request.isDuplicate ? `This endpoint was called ${request.duplicateCount} times this session.` : '',
    request.dependsOnCount > 0 ? `This request is part of a dependency chain with ${request.dependsOnCount} upstream request(s).` : '',
    '',
    'In 2-3 sentences, diagnose the most likely cause and suggest one specific fix.',
    'Be concrete. Do not give generic advice.',
  ].filter(Boolean).join('\n')
}

function parseAnthropicText(data: unknown) {
  const content = (data as { content?: Array<{ text?: string }> }).content
  return content?.find(item => typeof item.text === 'string')?.text ?? ''
}

async function getAnthropicApiKey() {
  const settings = await getSettings()
  return settings.apiKey.trim()
}

async function callAnthropic(apiKey: string, body: object) {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(errorBody.error?.message ?? `API error ${response.status}`)
  }

  return response.json()
}

async function testAiConnection(): Promise<AISuggestionResponse> {
  const apiKey = await getAnthropicApiKey()
  if (!apiKey) {
    return { ok: false, error: 'API key not configured. Add your Anthropic key in settings.' }
  }

  try {
    await callAnthropic(apiKey, {
      model: AI_TEST_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    })

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to connect to Anthropic.',
    }
  }
}

async function requestAiSuggestion(request: AISuggestionRequest): Promise<AISuggestionResponse> {
  const apiKey = await getAnthropicApiKey()
  if (!apiKey) {
    return { ok: false, error: 'API key not configured. Add your Anthropic key in settings.' }
  }

  const now = Date.now()
  const elapsed = now - lastAiRequestAt
  if (elapsed < AI_RATE_LIMIT_MS) {
    return {
      ok: false,
      error: `AI requests are rate limited. Try again in ${Math.ceil((AI_RATE_LIMIT_MS - elapsed) / 1000)}s.`,
      retryAfterMs: AI_RATE_LIMIT_MS - elapsed,
    }
  }

  lastAiRequestAt = now

  try {
    const data = await callAnthropic(apiKey, {
      model: AI_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: buildAiSuggestionPrompt(request) }],
    })
    const suggestion = parseAnthropicText(data)

    return {
      ok: true,
      suggestion: suggestion || 'No suggestion returned.',
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error. Check your API key.',
    }
  }
}

function rememberRequest(tabId: number, request: RequestEntry) {
  const receivedAt = Date.now()
  const networkEvent = findRecentNetworkEvent(tabId, request.method, request.url, receivedAt)
  const groups = getDuplicateGroups(tabId)
  const group = groups.get(request.fingerprint)
  const duplicateCount = (group?.count ?? 0) + 1
  const duplicateOf = group?.firstRequestId ?? null
  const previousRequests = getSession(tabId)
  const dependsOn = inferDependencies(request, previousRequests)
  const requestWithDuplicateInfo: RequestEntry = {
    ...request,
    isDuplicate: duplicateOf != null,
    duplicateOf,
    duplicateCount,
    dependsOn,
  }
  groups.set(request.fingerprint, {
    firstRequestId: group?.firstRequestId ?? request.id,
    count: duplicateCount,
  })

  const requestWithNetworkStatus = networkEvent && networkEvent.status !== requestWithDuplicateInfo.status
    ? { ...requestWithDuplicateInfo, status: networkEvent.status }
    : requestWithDuplicateInfo
  const requestsWithoutSameId = previousRequests.filter(entry => entry.id !== requestWithNetworkStatus.id)
  const requestsWithUpdatedGroup = requestsWithoutSameId.map(entry => (
    entry.fingerprint === requestWithNetworkStatus.fingerprint
      ? {
          ...entry,
          duplicateCount,
          duplicateOf: entry.id === (group?.firstRequestId ?? entry.id) ? null : group?.firstRequestId ?? null,
        }
      : entry
  ))
  const requests = [...requestsWithUpdatedGroup, requestWithNetworkStatus].slice(-MAX_REQUESTS_PER_TAB)

  requestsWithoutSameId
    .slice(0, Math.max(0, requestsWithoutSameId.length + 1 - MAX_REQUESTS_PER_TAB))
    .forEach(entry => requestReceivedAt.delete(entry.id))

  requestReceivedAt.set(requestWithNetworkStatus.id, receivedAt)
  sessionsByTab.set(tabId, requests)
  publishSession(tabId)
  chrome.runtime.sendMessage({
    type: 'DEPENDENCIES_UPDATED',
    payload: {
      requestId: requestWithNetworkStatus.id,
      dependsOn: requestWithNetworkStatus.dependsOn,
    },
  }).catch(() => {
    // No extension page is currently listening.
  })

  return {
    request: requestWithNetworkStatus,
    updatedRequests: requestsWithUpdatedGroup.filter(entry => entry.fingerprint === requestWithNetworkStatus.fingerprint),
  }
}

function inferDependencies(
  newRequest: RequestEntry,
  existingRequests: RequestEntry[],
): string[] {
  const dependsOn: string[] = []
  const newStart = newRequest.startTime

  for (const existing of existingRequests) {
    if (existing.id === newRequest.id) continue

    const existingEnd = existing.startTime + existing.duration
    const timingMatch =
      newStart >= existingEnd &&
      newStart <= existingEnd + 800

    if (!timingMatch) continue
    if (!existing.responseBody) continue

    let sharedValue = false
    try {
      const values = extractLeafValues(JSON.parse(existing.responseBody))
      for (const val of values) {
        if (
          val.length > 4 &&
          (
            newRequest.url.includes(val) ||
            (newRequest.requestBody ?? '').includes(val)
          )
        ) {
          sharedValue = true
          break
        }
      }
    } catch {
      continue
    }

    if (sharedValue) {
      dependsOn.push(existing.id)
    }
  }

  return dependsOn
}

function extractLeafValues(obj: unknown, depth = 0): string[] {
  if (depth > 6) return []
  if (typeof obj === 'string' || typeof obj === 'number') {
    return [String(obj)]
  }
  if (Array.isArray(obj)) {
    return obj.flatMap(item => extractLeafValues(item, depth + 1))
  }
  if (obj && typeof obj === 'object') {
    return Object.values(obj).flatMap(v => extractLeafValues(v, depth + 1))
  }
  return []
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

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId == null) return

  attachedDebuggerTabs.delete(source.tabId)
  cdpRequestsByTab.delete(source.tabId)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return
  const tabId = source.tabId
  const cdpRequests = getCdpRequests(tabId)

  if (method === 'Network.requestWillBeSent') {
    const requestId = String(params.requestId)
    cdpRequests.set(requestId, {
      requestId,
      url: String(params.request.url),
      method: String(params.request.method).toUpperCase(),
      wallTime: Math.round(Number(params.wallTime) * 1000),
      sentAt: Number(params.timestamp),
    })
    return
  }

  if (method === 'Network.responseReceived') {
    const requestId = String(params.requestId)
    const current = cdpRequests.get(requestId)
    if (!current) return

    cdpRequests.set(requestId, {
      ...current,
      status: Number(params.response.status),
      timing: params.response.timing as CdpTimingData | undefined,
    })
    return
  }

  if (method === 'Network.loadingFinished') {
    const requestId = String(params.requestId)
    const current = cdpRequests.get(requestId)
    if (!current) return

    const completed = {
      ...current,
      encodedDataLength: Number(params.encodedDataLength ?? 0),
      sentAt: Number(params.timestamp),
    }
    cdpRequests.set(requestId, completed)

    if (completed.matchedRequestId) {
      const timingPayload = buildCdpTimingPayload(completed.matchedRequestId, completed)
      if (timingPayload) {
        queueTimingUpdate(tabId, timingPayload)
      }
    }
    return
  }

  if (method === 'Network.loadingFailed') {
    const requestId = String(params.requestId)
    cdpRequests.delete(requestId)
  }
})

chrome.tabs.onRemoved.addListener(tabId => {
  sessionsByTab.delete(tabId)
  duplicateGroupsByTab.delete(tabId)
  replayTargetsByTab.delete(tabId)
  networkEventsByTab.delete(tabId)
  clearAllPendingRequests(tabId)
  void detachDebugger(tabId)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return

  sessionsByTab.delete(tabId)
  duplicateGroupsByTab.delete(tabId)
  replayTargetsByTab.delete(tabId)
  networkEventsByTab.delete(tabId)
  clearAllPendingRequests(tabId)
  cdpRequestsByTab.delete(tabId)
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

  if (message.type === 'SET_PRECISE_MODE') {
    setPreciseMode(message.payload.enabled).then(() => {
      sendResponse({ ok: true })
    }).catch(error => {
      console.warn('[API Debugger] Failed to change precise mode', error)
      sendResponse({ ok: false })
    })
    return true
  }

  if (message.type === 'TEST_AI_CONNECTION') {
    testAiConnection().then(sendResponse)
    return true
  }

  if (message.type === 'ASK_AI_SUGGESTION') {
    requestAiSuggestion(message.payload).then(sendResponse)
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

  if (message.type === 'CLEAR_SESSION') {
    sessionsByTab.delete(sender.tab.id)
    duplicateGroupsByTab.delete(sender.tab.id)
    replayTargetsByTab.delete(sender.tab.id)
    networkEventsByTab.delete(sender.tab.id)
    clearAllPendingRequests(sender.tab.id)
    cdpRequestsByTab.delete(sender.tab.id)
    publishSession(sender.tab.id)
    return false
  }

  if (message.type === 'REQUEST_COMPLETE') {
    queueRequestCompletion(sender.tab.id, message.payload)
    return false
  }

  if (message.type === 'TIMING_UPDATE') {
    queueTimingUpdate(sender.tab.id, message.payload)
    return false
  }

  if (message.type === 'REQUEST_FAILED') {
    chrome.tabs.sendMessage(sender.tab.id, message).catch(() => {
      // Tab may have navigated or closed - safe to ignore
    })
  }

  return false
})
