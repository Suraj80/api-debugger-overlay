import type {
  AISuggestionRequest,
  AISuggestionResponse,
  OverlayStateSnapshot,
  ReplayAck,
  ReplayProgressPayload,
  ReplayRequest,
  ReplayTargetSnapshot,
  RequestEntry,
  SessionSnapshot,
  TimingSource,
  TimingUpdatePayload,
} from '../shared/types'
import { getSettings, saveSettings } from '../shared/settings'

// MV3 service worker - no DOM, no window object
// Central message hub and in-memory session store for the extension

const MAX_REQUESTS_PER_TAB = 500
const MAX_NETWORK_EVENTS_PER_TAB = 200
const NETWORK_MATCH_WINDOW_MS = 5000
const PENDING_REQUEST_FALLBACK_MS = 1000
const PENDING_REQUEST_CLEANUP_MS = 5000
const CDP_MATCH_WINDOW_MS = 5000
const LOCALHOST_DURATION_CLAMP_DELTA_MS = 150
const LOCALHOST_DURATION_CLAMP_RATIO = 1.2
const AI_RATE_LIMIT_MS = 10000
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const AI_MODEL = 'gpt-5.4-mini'
const AI_TEST_MODEL = 'gpt-5.4-mini'
const sessionsByTab = new Map<number, RequestEntry[]>()
const duplicateGroupsByTab = new Map<number, Map<string, DuplicateGroup>>()
const replayTargetsByTab = new Map<number, ReplayTargetState>()
const pausedOverlayTabs = new Set<number>()
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

interface ReplayTargetState {
  request: ReplayRequest
  frameId?: number
  documentId?: string
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
  finishedAt: number
  matchedRequestId?: string
  status?: number
  timing?: CdpTimingData
  encodedDataLength?: number
}

interface CdpRequestWillBeSentParams {
  requestId?: unknown
  request?: {
    url?: unknown
    method?: unknown
  }
  wallTime?: unknown
  timestamp?: unknown
}

interface CdpResponseReceivedParams {
  requestId?: unknown
  response?: {
    status?: unknown
    timing?: unknown
  }
}

interface CdpLoadingFinishedParams {
  requestId?: unknown
  encodedDataLength?: unknown
  timestamp?: unknown
}

interface CdpLoadingFailedParams {
  requestId?: unknown
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

function isOverlayPaused(tabId: number) {
  return pausedOverlayTabs.has(tabId)
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

function isLoopbackRequest(url: string) {
  try {
    const { hostname } = new URL(url)
    const normalizedHost = hostname.toLowerCase()

    return (
      normalizedHost === 'localhost' ||
      normalizedHost.endsWith('.localhost') ||
      normalizedHost === '127.0.0.1' ||
      normalizedHost === '0.0.0.0' ||
      normalizedHost === '::1'
    )
  } catch {
    return false
  }
}

function shouldClampLoopbackPerformanceDuration(proxy: RequestEntry, timing: TimingUpdatePayload) {
  if (timing.timingSource !== 'performance') return false
  if (proxy.duration <= 0 || timing.duration <= proxy.duration) return false
  if (!isLoopbackRequest(timing.url || proxy.url)) return false

  const durationDelta = timing.duration - proxy.duration
  return durationDelta >= LOCALHOST_DURATION_CLAMP_DELTA_MS && timing.duration >= proxy.duration * LOCALHOST_DURATION_CLAMP_RATIO
}

export function mergeRequestTiming(proxy: RequestEntry, timing?: TimingUpdatePayload): RequestEntry {
  if (!timing) return proxy
  const clampLoopbackDuration = shouldClampLoopbackPerformanceDuration(proxy, timing)
  const mergedDuration = clampLoopbackDuration
    ? proxy.duration
    : timing.duration > 0
      ? timing.duration
      : proxy.duration

  const timingSource: TimingSource = timing.timingSource === 'cdp'
    ? 'cdp'
    : (
        timing.duration > 0 ||
        timing.ttfb > 0 ||
        timing.dnsTime > 0 ||
        timing.connectTime > 0 ||
        timing.sslTime > 0 ||
        timing.requestTime > 0 ||
        timing.responseTime > 0
      )
      ? 'performance'
      : proxy.timingSource

  return {
    ...proxy,
    duration: mergedDuration,
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
    ? Math.max(0, Math.round((cdpRequest.finishedAt - timing.requestTime) * 1000))
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

async function ensurePreciseModeForTab(tabId: number | undefined) {
  if (tabId == null) return

  const settings = await getSettings()
  if (!settings.preciseModeEnabled) return

  await attachDebugger(tabId)
}

async function disablePreciseModeSetting() {
  const settings = await getSettings()
  if (!settings.preciseModeEnabled) return

  await saveSettings({
    ...settings,
    preciseModeEnabled: false,
  })
}

async function getOverlayStateSnapshot(tabId?: number): Promise<OverlayStateSnapshot> {
  const resolvedTabId = tabId ?? await getActiveTabId()

  return {
    tabId: resolvedTabId ?? null,
    paused: resolvedTabId != null ? pausedOverlayTabs.has(resolvedTabId) : false,
  }
}

export function sanitizeUrlForAi(url: string) {
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
  const isProblemRequest = request.isSlow || request.status === 0 || request.status >= 400

  return [
    isProblemRequest
      ? `An API request was flagged as ${request.isSlow ? 'slow' : 'failed'}.`
      : 'A developer wants help understanding an API request.',
    `Method: ${request.method}`,
    `Endpoint: ${sanitizedUrl}`,
    `Status: ${request.status}`,
    `Duration: ${request.duration}ms`,
    `TTFB: ${request.ttfb}ms`,
    `Response size: ${request.responseSize} bytes`,
    request.isDuplicate ? `This endpoint was called ${request.duplicateCount} times this session.` : '',
    request.dependsOnCount > 0 ? `This request is part of a dependency chain with ${request.dependsOnCount} upstream request(s).` : '',
    '',
    'Reply using exactly these section headings:',
    'General info:',
    'Output:',
    'Solution to issue:',
    '',
    isProblemRequest
      ? 'For "General info", explain what the API likely does and why the page may call it. For "Output", summarize what is notable about the response or timing. For "Solution to issue", give one concrete fix for the likely issue.'
      : 'For "General info", explain what the API likely does and why the page may call it. For "Output", summarize what is notable about the request or response. For "Solution to issue", say "No issue detected." unless there is a meaningful concern worth calling out.',
    'Keep each section short and concrete. Do not give generic advice.',
  ].filter(Boolean).join('\n')
}

export function parseOpenAiText(data: unknown) {
  const response = data as {
    output_text?: unknown
    output?: Array<{
      type?: unknown
      content?: Array<{
        type?: unknown
        text?: unknown
      }>
    }>
  }

  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text
  }

  const parts = response.output
    ?.flatMap(item => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) return []

      return item.content.flatMap(contentItem => (
        contentItem?.type === 'output_text' && typeof contentItem.text === 'string'
          ? [contentItem.text]
          : []
      ))
    })
    .filter(Boolean) ?? []

  return parts.join('\n').trim()
}

async function getOpenAiApiKey() {
  const settings = await getSettings()
  return settings.apiKey.trim()
}

async function callOpenAi(apiKey: string, body: object) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
  const apiKey = await getOpenAiApiKey()
  if (!apiKey) {
    return { ok: false, error: 'API key not configured. Add your OpenAI key in settings.' }
  }

  try {
    await callOpenAi(apiKey, {
      model: AI_TEST_MODEL,
      input: 'hi',
      max_output_tokens: 20,
    })

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to connect to OpenAI.',
    }
  }
}

async function requestAiSuggestion(request: AISuggestionRequest): Promise<AISuggestionResponse> {
  const apiKey = await getOpenAiApiKey()
  if (!apiKey) {
    return { ok: false, error: 'API key not configured. Add your OpenAI key in settings.' }
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
    const data = await callOpenAi(apiKey, {
      model: AI_MODEL,
      input: buildAiSuggestionPrompt(request),
      max_output_tokens: 200,
    })
    const suggestion = parseOpenAiText(data)
    const finalSuggestion = suggestion || 'No suggestion returned.'

    await persistAiSuggestionForRequest(request.id, finalSuggestion)

    return {
      ok: true,
      suggestion: finalSuggestion,
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

export function inferDependencies(
  newRequest: RequestEntry,
  existingRequests: RequestEntry[],
): string[] {
  const newStart = newRequest.startTime
  const newSignals = extractRequestSignals(newRequest)
  const candidates: Array<{ id: string; score: number }> = []

  for (const existing of existingRequests) {
    if (existing.id === newRequest.id) continue

    const existingEnd = existing.startTime + existing.duration
    const deltaMs = newStart - existingEnd
    if (deltaMs < 0 || deltaMs > 1500) continue

    const timingScore = scoreDependencyTiming(deltaMs)
    if (timingScore <= 0) continue

    const existingSignals = extractRequestSignals(existing)
    const sharedValues = intersectSignals(existingSignals, newSignals)
    if (sharedValues.length === 0) continue

    const hostScore = sameOrigin(existing.url, newRequest.url) ? 1.5 : 0
    const pathScore = sharedPathPrefix(existing.url, newRequest.url) ? 1 : 0
    const tokenScore = sharedValues
      .slice(0, 4)
      .reduce((sum, value) => sum + scoreSignal(value), 0)
    const score = timingScore + hostScore + pathScore + tokenScore

    if (score >= 5.5) {
      candidates.push({ id: existing.id, score })
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(candidate => candidate.id)
}

export function extractLeafValues(obj: unknown, depth = 0): string[] {
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

function extractRequestSignals(request: RequestEntry) {
  const values = new Set<string>()
  const addValue = (value: string) => {
    const normalized = normalizeSignal(value)
    if (!normalized) return
    values.add(normalized)
  }

  extractUrlSignals(request.url).forEach(addValue)
  extractTextSignals(request.requestBody).forEach(addValue)
  extractJsonSignals(request.requestBody).forEach(addValue)
  extractJsonSignals(request.responseBody).forEach(addValue)

  return values
}

function extractUrlSignals(url: string) {
  try {
    const parsed = new URL(url)
    const signals = [
      ...parsed.pathname.split('/'),
      ...parsed.searchParams.keys(),
      ...Array.from(parsed.searchParams.values()),
    ]

    return signals.flatMap(value => tokenizeSignal(value))
  } catch {
    return tokenizeSignal(url)
  }
}

function extractTextSignals(value: string | null) {
  if (!value) return []
  return tokenizeSignal(value)
}

function extractJsonSignals(value: string | null) {
  if (!value) return []

  try {
    return extractLeafValues(JSON.parse(value)).flatMap(item => tokenizeSignal(item))
  } catch {
    return []
  }
}

function tokenizeSignal(value: string) {
  return value
    .split(/[^a-zA-Z0-9:_-]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

function normalizeSignal(value: string) {
  const normalized = value.trim().toLowerCase()
  if (normalized.length < 3) return ''
  if (/^(true|false|null|undefined|ok|data|items|list|page|limit|offset|sort|order|desc|asc)$/i.test(normalized)) return ''
  if (/^\d{1,2}$/.test(normalized)) return ''
  return normalized
}

function intersectSignals(left: Set<string>, right: Set<string>) {
  const shared: string[] = []

  for (const value of left) {
    if (right.has(value)) {
      shared.push(value)
    }
  }

  return shared.sort((a, b) => scoreSignal(b) - scoreSignal(a))
}

function scoreDependencyTiming(deltaMs: number) {
  if (deltaMs <= 50) return 5
  if (deltaMs <= 150) return 4
  if (deltaMs <= 400) return 2.5
  if (deltaMs <= 800) return 1.5
  if (deltaMs <= 1500) return 0.5
  return 0
}

function scoreSignal(value: string) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value)) return 4.5
  if (/^[a-z0-9_-]{10,}$/i.test(value)) return 3.5
  if (/^\d{3,}$/.test(value)) return 2.5
  if (value.length >= 6) return 2
  return 1
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function sharedPathPrefix(left: string, right: string) {
  try {
    const leftParts = new URL(left).pathname.split('/').filter(Boolean)
    const rightParts = new URL(right).pathname.split('/').filter(Boolean)
    if (leftParts.length === 0 || rightParts.length === 0) return false
    return leftParts[0] === rightParts[0]
  } catch {
    return false
  }
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

async function getTabLabel(tabId: number | null): Promise<string | null> {
  if (tabId == null) return null

  try {
    const tab = await chrome.tabs.get(tabId)
    const title = tab.title?.trim()
    if (title) return title

    if (tab.url) {
      try {
        return new URL(tab.url).hostname
      } catch {
        return tab.url
      }
    }
  } catch {
    // Ignore tabs that are no longer available.
  }

  return null
}

function pickTrackedTabId(preferredTabId: number | null | undefined, candidates: Iterable<number>) {
  if (preferredTabId != null) {
    for (const candidate of candidates) {
      if (candidate === preferredTabId) {
        return preferredTabId
      }
    }
  }

  const uniqueCandidates = Array.from(new Set(candidates))
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : preferredTabId ?? null
}

async function getSessionSnapshot(tabId?: number): Promise<SessionSnapshot> {
  const activeTabId = tabId ?? await getActiveTabId()
  const resolvedTabId = pickTrackedTabId(activeTabId, sessionsByTab.keys())
  const tabLabel = await getTabLabel(resolvedTabId)

  return {
    tabId: resolvedTabId,
    tabLabel,
    requests: resolvedTabId == null ? [] : getSession(resolvedTabId),
  }
}

async function getReplayTargetSnapshot(tabId?: number): Promise<ReplayTargetSnapshot> {
  const activeTabId = tabId ?? await getActiveTabId()
  const resolvedTabId = pickTrackedTabId(activeTabId, replayTargetsByTab.keys())

  return {
    tabId: resolvedTabId,
    request: resolvedTabId == null ? null : replayTargetsByTab.get(resolvedTabId)?.request ?? null,
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

function publishReplayProgress(tabId: number, payload: ReplayProgressPayload) {
  chrome.runtime.sendMessage({
    type: 'REPLAY_PROGRESS',
    tabId,
    payload,
  }).catch(() => {
    // No extension page is currently listening.
  })
}

function sanitizeReplayHeaders(headers: Record<string, string>) {
  const blockedHeaders = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'referer',
    'user-agent',
  ])

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => {
        const normalizedKey = key.toLowerCase()
        return !blockedHeaders.has(normalizedKey) && !normalizedKey.startsWith('sec-')
      })
      .map(([key, value]) => [key, value]),
  )
}

function decodeReplayBody(buffer: ArrayBuffer, contentType: string) {
  if (!buffer.byteLength) return ''
  if (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('graphql') ||
    contentType.includes('x-www-form-urlencoded')
  ) {
    try {
      return new TextDecoder().decode(buffer)
    } catch {
      return '[Replay response body unavailable: unable to decode text payload]'
    }
  }

  return `[Binary replay response omitted: ${contentType || 'unknown content type'}, ${buffer.byteLength} bytes]`
}

async function runReplayFromBackground(tabId: number, request: ReplayRequest, jobId: string) {
  const startTime = Date.now()
  publishReplayProgress(tabId, {
    jobId,
    phase: 'started',
  })

  try {
    const method = request.method.toUpperCase()
    const init: RequestInit = {
      method,
      headers: sanitizeReplayHeaders(request.headers || {}),
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    }

    if (!['GET', 'HEAD'].includes(method) && request.body) {
      init.body = request.body
    }

    const response = await fetch(request.url, init)
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    publishReplayProgress(tabId, {
      jobId,
      phase: 'headers',
      result: {
        status: response.status,
        duration: Date.now() - startTime,
        responseBody: null,
        responseHeaders,
      },
    })

    const contentType = response.headers.get('content-type') || ''
    const buffer = await response.clone().arrayBuffer()
    publishReplayProgress(tabId, {
      jobId,
      phase: 'complete',
      result: {
        status: response.status,
        duration: Date.now() - startTime,
        responseBody: decodeReplayBody(buffer, contentType),
        responseHeaders,
      },
    })
  } catch (error) {
    publishReplayProgress(tabId, {
      jobId,
      phase: 'error',
      result: {
        status: 0,
        duration: Date.now() - startTime,
        responseBody: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        responseHeaders: {},
      },
    })
  }
}

async function persistAiSuggestionForRequest(requestId: string, suggestion: string) {
  const tabId = await getActiveTabId()
  if (tabId == null) return

  const requests = getSession(tabId)
  const matchIndex = requests.findIndex(request => request.id === requestId)
  if (matchIndex === -1) return

  const updatedRequest: RequestEntry = {
    ...requests[matchIndex],
    aiSuggestion: suggestion,
  }
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

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return

  attachedDebuggerTabs.delete(source.tabId)
  cdpRequestsByTab.delete(source.tabId)

  if (reason === 'canceled_by_user') {
    void disablePreciseModeSetting().catch(() => {
      // Ignore storage write failures during debugger teardown.
    })
  }
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return
  const tabId = source.tabId
  if (isOverlayPaused(tabId)) return
  const cdpRequests = getCdpRequests(tabId)

  if (method === 'Network.requestWillBeSent') {
    const requestParams = params as CdpRequestWillBeSentParams
    const request = requestParams.request
    const requestId = requestParams.requestId
    const wallTime = requestParams.wallTime
    const timestamp = requestParams.timestamp

    if (!request || request.url == null || request.method == null || requestId == null || wallTime == null || timestamp == null) {
      return
    }

    cdpRequests.set(String(requestId), {
      requestId: String(requestId),
      url: String(request.url),
      method: String(request.method).toUpperCase(),
      wallTime: Math.round(Number(wallTime) * 1000),
      finishedAt: Number(timestamp),
    })
    return
  }

  if (method === 'Network.responseReceived') {
    const responseParams = params as CdpResponseReceivedParams
    const requestId = responseParams.requestId
    const response = responseParams.response
    if (requestId == null || !response) return

    const current = cdpRequests.get(String(requestId))
    if (!current) return

    cdpRequests.set(String(requestId), {
      ...current,
      status: Number(response.status),
      timing: response.timing as CdpTimingData | undefined,
    })
    return
  }

  if (method === 'Network.loadingFinished') {
    const loadingFinishedParams = params as CdpLoadingFinishedParams
    const requestId = loadingFinishedParams.requestId
    if (requestId == null) return

    const current = cdpRequests.get(String(requestId))
    if (!current) return

    const completed = {
      ...current,
      encodedDataLength: Number(loadingFinishedParams.encodedDataLength ?? 0),
      finishedAt: Number(loadingFinishedParams.timestamp ?? current.finishedAt),
    }
    cdpRequests.set(String(requestId), completed)

    if (completed.matchedRequestId) {
      const timingPayload = buildCdpTimingPayload(completed.matchedRequestId, completed)
      if (timingPayload) {
        queueTimingUpdate(tabId, timingPayload)
      }
    }
    return
  }

  if (method === 'Network.loadingFailed') {
    const loadingFailedParams = params as CdpLoadingFailedParams
    const requestId = loadingFailedParams.requestId
    if (requestId == null) return

    cdpRequests.delete(String(requestId))
  }
})

chrome.tabs.onRemoved.addListener(tabId => {
  sessionsByTab.delete(tabId)
  duplicateGroupsByTab.delete(tabId)
  replayTargetsByTab.delete(tabId)
  pausedOverlayTabs.delete(tabId)
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ensurePreciseModeForTab(tabId).catch(() => {
    // Ignore tabs that cannot be attached in the current browser state.
  })
})

chrome.webRequest.onCompleted.addListener(details => {
  if (details.tabId < 0) return
  if (isOverlayPaused(details.tabId)) return

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

  if (message.type === 'GET_OVERLAY_STATE') {
    void ensurePreciseModeForTab(sender.tab?.id ?? message.tabId).catch(() => {
      // Ignore attach failures here; overlay state can still be returned.
    })
    getOverlayStateSnapshot(message.tabId).then(sendResponse)
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
    const jobId = message.payload.jobId ?? crypto.randomUUID()
    void runReplayFromBackground(message.tabId, message.payload, jobId)
    sendResponse({
      ok: true,
      jobId,
    } satisfies ReplayAck)
    return false
  }

  if (!sender.tab?.id) return false

  if (message.type === 'REPLAY_PROGRESS') {
    publishReplayProgress(sender.tab.id, message.payload)
    return false
  }

  if (message.type === 'SET_OVERLAY_PAUSED') {
    if (message.payload.paused) {
      pausedOverlayTabs.add(sender.tab.id)
      networkEventsByTab.delete(sender.tab.id)
      clearAllPendingRequests(sender.tab.id)
      cdpRequestsByTab.delete(sender.tab.id)
    } else {
      pausedOverlayTabs.delete(sender.tab.id)
    }
    sendResponse({ ok: true })
    return false
  }

  if (message.type === 'OPEN_SIDE_PANEL') {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {
      // Side panel open can fail if Chrome does not treat the source as a user gesture.
    })
    return false
  }

  if (message.type === 'SELECT_REPLAY') {
    replayTargetsByTab.set(sender.tab.id, {
      request: message.payload,
      frameId: sender.frameId,
      documentId: sender.documentId,
    })
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
    if (isOverlayPaused(sender.tab.id)) return false
    queueRequestCompletion(sender.tab.id, message.payload)
    return false
  }

  if (message.type === 'TIMING_UPDATE') {
    if (isOverlayPaused(sender.tab.id)) return false
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
