// Runs in page context - has access to real window.fetch and XHR.
// Only bridge to extension: window.postMessage.

const originalFetch = window.fetch.bind(window)
const originalXhrOpen = XMLHttpRequest.prototype.open
const originalXhrSend = XMLHttpRequest.prototype.send
const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  captureFetch: true,
  captureXHR: false,
  slowRequestThresholdMs: 1500,
  largePayloadThresholdKb: 500,
}
let settings = { ...DEFAULT_SETTINGS }
const xhrMeta = new WeakMap()
const MAX_FINGERPRINTS = 1000
const seenFingerprints = new Set()
const pendingObservedRequests = []
const MATCH_WINDOW_MS = 5000

function addFingerprint(fp) {
  if (seenFingerprints.size >= MAX_FINGERPRINTS) {
    const first = seenFingerprints.values().next().value
    seenFingerprints.delete(first)
  }

  seenFingerprints.add(fp)
}

function hasFingerprint(fp) {
  return seenFingerprints.has(fp)
}

function createRequestEntry({
  id,
  url,
  method,
  status,
  duration,
  startTime,
  requestSize = 0,
  requestHeaders = {},
  requestBody = null,
  responseSize = 0,
  responseBody = null,
  body = null,
  ttfb = 0,
}) {
  const fingerprint = createFingerprint(method, url, body)
  const isDuplicate = hasFingerprint(fingerprint)

  addFingerprint(fingerprint)

  return {
    id,
    url,
    method,
    status,
    duration,
    startTime,
    requestSize,
    responseSize,
    decodedBodySize: responseSize,
    transferSize: responseSize,
    requestHeaders,
    requestBody,
    responseBody,
    isDuplicate,
    duplicateOf: null,
    duplicateCount: 1,
    isSlow: duration > settings.slowRequestThresholdMs,
    aiSuggestion: null,
    dependsOn: [],
    fingerprint,
    ttfb,
    dnsTime: 0,
    connectTime: 0,
    sslTime: 0,
    requestTime: 0,
    responseTime: 0,
    timingSource: 'proxy',
  }
}

function toAbsoluteTime(relativeTime) {
  return Math.round(performance.timeOrigin + relativeTime)
}

function rememberPerformanceEntries(entries) {
  processPerformanceEntries(entries)
}

function startPerformanceObserver() {
  try {
    const observer = new PerformanceObserver(list => {
      rememberPerformanceEntries(list.getEntries())
    })

    observer.observe({ type: 'resource', buffered: true })
  } catch {
    // Some pages can restrict PerformanceObserver. Request capture still works without TTFB.
  }
}

startPerformanceObserver()

function isTextLikeContentType(contentType) {
  const value = String(contentType || '').toLowerCase()

  return (
    value.startsWith('text/') ||
    value.includes('json') ||
    value.includes('xml') ||
    value.includes('javascript') ||
    value.includes('graphql') ||
    value.includes('x-www-form-urlencoded')
  )
}

function decodeCapturedBody(buffer, contentType) {
  if (!buffer || buffer.byteLength === 0) return ''
  if (buffer.byteLength > settings.largePayloadThresholdKb * 1024) return null
  if (!isTextLikeContentType(contentType)) return null

  try {
    return new TextDecoder().decode(buffer)
  } catch {
    return null
  }
}

function parseContentLength(raw) {
  if (!raw) return 0

  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function getContentLength(headers) {
  return parseContentLength(headers?.get?.('content-length'))
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function buildPayloadNotice(label, parts) {
  return `[${label}: ${parts.filter(Boolean).join(', ')}]`
}

async function captureFetchResponsePayload(response) {
  try {
    const contentType = response.headers?.get?.('content-type') || ''
    const contentLength = getContentLength(response.headers)
    const largePayloadThresholdBytes = settings.largePayloadThresholdKb * 1024

    if (contentLength > largePayloadThresholdBytes) {
      return {
        responseSize: contentLength,
        responseBody: buildPayloadNotice('Response body omitted', [
          `over capture limit ${formatBytes(largePayloadThresholdBytes)}`,
          formatBytes(contentLength),
          contentType || 'unknown content type',
        ]),
      }
    }

    if (!isTextLikeContentType(contentType)) {
      return {
        responseSize: contentLength,
        responseBody: buildPayloadNotice('Binary response omitted', [
          contentType || 'unknown content type',
          contentLength ? formatBytes(contentLength) : '',
        ]),
      }
    }

    const buffer = await response.clone().arrayBuffer()
    const decoded = decodeCapturedBody(buffer, contentType)

    return {
      responseSize: contentLength || buffer.byteLength,
      responseBody: decoded ?? buildPayloadNotice('Response body unavailable', [
        'unable to decode captured payload',
        contentType || 'unknown content type',
        formatBytes(contentLength || buffer.byteLength),
      ]),
    }
  } catch (error) {
    return {
      responseSize: 0,
      responseBody: buildPayloadNotice('Response body unavailable', [
        error instanceof Error ? error.message : String(error),
      ]),
    }
  }
}

function captureXhrResponsePayload(xhr) {
  try {
    const contentType = xhr.getResponseHeader?.('content-type') || ''
    const contentLength = parseContentLength(xhr.getResponseHeader?.('content-length'))
    const largePayloadThresholdBytes = settings.largePayloadThresholdKb * 1024

    if (contentLength > largePayloadThresholdBytes) {
      return {
        responseSize: contentLength,
        responseBody: buildPayloadNotice('Response body omitted', [
          `over capture limit ${formatBytes(largePayloadThresholdBytes)}`,
          formatBytes(contentLength),
          contentType || 'unknown content type',
        ]),
      }
    }

    if (xhr.responseType === '' || xhr.responseType === 'text') {
      const responseBody = xhr.responseText ?? ''

      return {
        responseSize: contentLength || getBodySize(responseBody),
        responseBody: isTextLikeContentType(contentType) ? responseBody : null,
      }
    }

    if (xhr.responseType === 'json') {
      const responseBody = xhr.response == null ? null : JSON.stringify(xhr.response)

      return {
        responseSize: contentLength || getBodySize(responseBody),
        responseBody,
      }
    }

    if (xhr.response instanceof ArrayBuffer) {
      const decoded = decodeCapturedBody(xhr.response, contentType)
      return {
        responseSize: xhr.response.byteLength,
        responseBody: decoded ?? buildPayloadNotice('Binary response omitted', [
          contentType || xhr.responseType || 'arraybuffer',
          formatBytes(xhr.response.byteLength),
        ]),
      }
    }

    if (xhr.response instanceof Blob) {
      return {
        responseSize: xhr.response.size,
        responseBody: buildPayloadNotice('Binary response omitted', [
          xhr.response.type || contentType || 'blob',
          formatBytes(xhr.response.size),
        ]),
      }
    }

    return {
      responseSize: getBodySize(xhr.response),
      responseBody: buildPayloadNotice('Response body unavailable', [
        xhr.responseType || 'unsupported XHR response type',
      ]),
    }
  } catch (error) {
    return {
      responseSize: 0,
      responseBody: buildPayloadNotice('Response body unavailable', [
        error instanceof Error ? error.message : String(error),
      ]),
    }
  }
}

function safePostMessage(message) {
  try {
    window.postMessage(message, '*')
  } catch {
    // Some restrictive page environments can block message bridging.
  }
}

function postRequestComplete(entry) {
  safePostMessage({
    source: 'api-debugger-injected',
    type: 'REQUEST_COMPLETE',
    payload: entry
  })
}

function postTimingUpdate(payload) {
  safePostMessage({
    source: 'api-debugger-injected',
    type: 'TIMING_UPDATE',
    payload,
  })
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if (event.data?.source !== 'api-debugger-content') return

  if (event.data?.type === 'API_DEBUGGER_SETTINGS') {
    settings = {
      ...DEFAULT_SETTINGS,
      ...(event.data.payload || {}),
    }
  }

  if (event.data?.type === 'API_DEBUGGER_REPLAY') {
    replayRequest(event.data.requestId, event.data.payload)
  }
})

function getBodySize(body) {
  if (!body) return 0
  if (typeof body === 'string') return new Blob([body]).size
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof FormData || body instanceof URLSearchParams) return new Blob([body.toString()]).size

  try {
    return new Blob([JSON.stringify(body)]).size
  } catch {
    return 0
  }
}

function headersToObject(headers) {
  const result = {}

  if (!headers) return result

  try {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        result[key] = value
      })
      return result
    }

    if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        result[String(key)] = String(value)
      })
      return result
    }

    Object.entries(headers).forEach(([key, value]) => {
      result[key] = String(value)
    })
  } catch {
    return result
  }

  return result
}

function mergeHeaders(...headerSets) {
  return Object.assign({}, ...headerSets.map(headersToObject))
}

function bodyToReplayString(body) {
  if (!body) return null
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof FormData) return normalizeFormData(body)
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return null

  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

async function readRequestBody(input) {
  if (!(input instanceof Request)) return null

  try {
    return await input.clone().text()
  } catch {
    return null
  }
}

function createFingerprint(method, url, body) {
  return fnv1aHash([
    method.toUpperCase(),
    normalizeUrl(url),
    normalizeBody(body),
  ].join('|'))
}

function normalizeUrl(url) {
  try {
    const parsedUrl = new URL(url, window.location.href)
    const sortedParams = [...parsedUrl.searchParams.entries()]
      .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))

    parsedUrl.search = ''

    for (const [key, value] of sortedParams) {
      parsedUrl.searchParams.append(key, value)
    }

    return parsedUrl.href
  } catch {
    return String(url)
  }
}

function absoluteUrl(url) {
  try {
    return new URL(url, window.location.href).href
  } catch {
    return String(url)
  }
}

function decodeUrl(url) {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

function getPathname(url) {
  try {
    return new URL(url, window.location.href).pathname
  } catch {
    return String(url)
  }
}

function urlsRoughlyMatch(left, right) {
  const absoluteLeft = absoluteUrl(left)
  const absoluteRight = absoluteUrl(right)

  return (
    absoluteLeft === absoluteRight ||
    decodeUrl(absoluteLeft) === decodeUrl(absoluteRight) ||
    getPathname(absoluteLeft) === getPathname(absoluteRight)
  )
}

function registerObservedRequest(meta) {
  pendingObservedRequests.push(meta)

  if (pendingObservedRequests.length > 500) {
    pendingObservedRequests.splice(0, pendingObservedRequests.length - 500)
  }
}

function emitTimingUpdate(requestId, entry) {
  const requestStart = entry.requestStart > 0 ? entry.requestStart : entry.startTime
  const responseStart = entry.responseStart > 0 ? entry.responseStart : 0
  const responseEnd = entry.responseEnd > 0 ? entry.responseEnd : responseStart

  postTimingUpdate({
    id: requestId,
    url: entry.name,
    duration: Math.round(entry.duration),
    startTime: toAbsoluteTime(entry.startTime),
    ttfb: responseStart > 0 && requestStart > 0 ? Math.max(0, Math.round(responseStart - requestStart)) : 0,
    dnsTime: entry.domainLookupEnd > 0 && entry.domainLookupStart >= 0
      ? Math.max(0, Math.round(entry.domainLookupEnd - entry.domainLookupStart))
      : 0,
    connectTime: entry.connectEnd > 0 && entry.connectStart >= 0
      ? Math.max(0, Math.round(entry.connectEnd - entry.connectStart))
      : 0,
    sslTime: entry.secureConnectionStart > 0 && entry.connectEnd > 0
      ? Math.max(0, Math.round(entry.connectEnd - entry.secureConnectionStart))
      : 0,
    requestTime: responseStart > 0 && requestStart > 0 ? Math.max(0, Math.round(responseStart - requestStart)) : 0,
    responseTime: responseEnd > 0 && responseStart > 0 ? Math.max(0, Math.round(responseEnd - responseStart)) : 0,
    responseSize: entry.encodedBodySize || 0,
    decodedBodySize: entry.decodedBodySize || 0,
    transferSize: entry.transferSize || 0,
    timingSource: 'performance',
  })
}

function matchPerformanceEntry(entry) {
  const absoluteEntryUrl = absoluteUrl(entry.name)
  let bestIndex = -1
  let bestDelta = Number.POSITIVE_INFINITY

  for (let index = pendingObservedRequests.length - 1; index >= 0; index -= 1) {
    const pending = pendingObservedRequests[index]
    if (pending.matched) continue
    if (!urlsRoughlyMatch(pending.url, absoluteEntryUrl)) continue

    const delta = Math.abs(entry.startTime - pending.startTime)
    if (delta < bestDelta) {
      bestDelta = delta
      bestIndex = index
    }
  }

  if (bestIndex === -1 || bestDelta > MATCH_WINDOW_MS) return

  const matchedRequestId = pendingObservedRequests[bestIndex].id
  pendingObservedRequests[bestIndex].matched = true
  emitTimingUpdate(matchedRequestId, entry)

  window.setTimeout(() => {
    const staleIndex = pendingObservedRequests.findIndex(pending => pending.id === matchedRequestId)
    if (staleIndex >= 0) {
      pendingObservedRequests.splice(staleIndex, 1)
    }
  }, 0)
}

function processPerformanceEntries(entries) {
  for (const entry of entries) {
    if (entry.entryType !== 'resource') continue
    if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest' && entry.initiatorType !== 'other') continue

    matchPerformanceEntry(entry)
  }
}

function normalizeBody(body) {
  if (!body) return ''
  if (typeof body === 'string') return normalizeJsonString(body)
  if (body instanceof URLSearchParams) return normalizeUrlSearchParams(body)
  if (body instanceof FormData) return normalizeFormData(body)
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return `[binary:${getBodySize(body)}]`
  }

  try {
    return stableStringify(body)
  } catch {
    return String(body)
  }
}

function normalizeJsonString(value) {
  try {
    return stableStringify(JSON.parse(value))
  } catch {
    return value
  }
}

function normalizeUrlSearchParams(params) {
  return [...params.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

function normalizeFormData(formData) {
  return [...formData.entries()]
    .map(([key, value]) => [key, value instanceof File ? `[file:${value.name}:${value.size}]` : String(value)])
    .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

function fnv1aHash(value) {
  let hash = 0x811c9dc5

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

const interceptedFetch = async (input, init) => {
  if (!settings.captureEnabled || !settings.captureFetch) {
    return originalFetch(input, init)
  }

  const startTime = performance.now()
  const url = input instanceof Request ? input.url : input.toString()
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const requestHeaders = mergeHeaders(input instanceof Request ? input.headers : null, init?.headers)
  const requestBodySource = init?.body ?? await readRequestBody(input)
  const requestBody = bodyToReplayString(requestBodySource)
  const requestId = crypto.randomUUID()

  registerObservedRequest({
    id: requestId,
    url: absoluteUrl(url),
    startTime,
    matched: false,
  })

  try {
    const response = await originalFetch(input, init)
    const duration = Math.round(performance.now() - startTime)
    const requestSize = getBodySize(requestBodySource)

    captureFetchResponsePayload(response).then(({ responseSize, responseBody }) => {
      postRequestComplete(createRequestEntry({
        id: requestId,
        url,
        method,
        status: response.status,
        duration,
        startTime: toAbsoluteTime(startTime),
        requestSize,
        requestHeaders,
        requestBody,
        responseSize,
        responseBody,
        body: requestBodySource,
      }))
    })

    return response
  } catch (error) {
    const pendingIndex = pendingObservedRequests.findIndex(pending => pending.id === requestId)
    if (pendingIndex >= 0) {
      pendingObservedRequests.splice(pendingIndex, 1)
    }
    postRequestComplete(createRequestEntry({
      id: requestId,
      url,
      method,
      status: 0,
      duration: Math.round(performance.now() - startTime),
      startTime: toAbsoluteTime(startTime),
      requestSize: getBodySize(requestBodySource),
      requestHeaders,
      requestBody,
      responseSize: 0,
      responseBody: buildPayloadNotice(error?.name === 'AbortError' ? 'Request aborted' : 'Request failed', [
        error instanceof Error ? error.message : String(error),
      ]),
      body: requestBodySource,
      ttfb: 0,
    }))
    throw error
  }
}

const interceptedXhrOpen = function (method, url, async, user, password) {
  if (settings.captureEnabled && settings.captureXHR) {
    xhrMeta.set(this, {
      id: crypto.randomUUID(),
      method: String(method || 'GET').toUpperCase(),
      url: String(url),
      requestHeaders: {},
      requestBody: null,
      startTime: 0,
      requestSize: 0,
    })
  } else {
    xhrMeta.delete(this)
  }

  return originalXhrOpen.apply(this, arguments)
}

const interceptedXhrSetRequestHeader = function (name, value) {
  const meta = xhrMeta.get(this)

  if (meta) {
    meta.requestHeaders[String(name)] = String(value)
  }

  return originalXhrSetRequestHeader.apply(this, arguments)
}

const interceptedXhrSend = function (body) {
  const meta = xhrMeta.get(this)

  if (!meta || !settings.captureEnabled || !settings.captureXHR) {
    xhrMeta.delete(this)
    return originalXhrSend.apply(this, arguments)
  }

  meta.startTime = performance.now()
  meta.requestSize = getBodySize(body)
  meta.requestBody = bodyToReplayString(body)
  registerObservedRequest({
    id: meta.id,
    url: absoluteUrl(meta.url),
    startTime: meta.startTime,
    matched: false,
  })

  const handleLoadEnd = () => {
    const duration = Math.round(performance.now() - meta.startTime)
    const { responseSize, responseBody } = captureXhrResponsePayload(this)

    postRequestComplete(createRequestEntry({
      id: meta.id,
      url: meta.url,
      method: meta.method,
      status: this.status,
      duration,
      startTime: toAbsoluteTime(meta.startTime),
      requestSize: meta.requestSize,
      requestHeaders: meta.requestHeaders,
      requestBody: meta.requestBody,
      responseSize,
      responseBody,
      body,
    }))

    xhrMeta.delete(this)
  }

  const handleError = (event) => {
    const pendingIndex = pendingObservedRequests.findIndex(pending => pending.id === meta.id)
    if (pendingIndex >= 0) {
      pendingObservedRequests.splice(pendingIndex, 1)
    }
    const errorLabel = event?.type === 'abort'
      ? 'Request aborted'
      : event?.type === 'timeout'
        ? 'Request timed out'
        : 'Request failed'

    postRequestComplete(createRequestEntry({
      id: meta.id,
      url: meta.url,
      method: meta.method,
      status: this.status || 0,
      duration: Math.round(performance.now() - meta.startTime),
      startTime: toAbsoluteTime(meta.startTime),
      requestSize: meta.requestSize,
      requestHeaders: meta.requestHeaders,
      requestBody: meta.requestBody,
      responseSize: 0,
      responseBody: buildPayloadNotice(errorLabel, [
        event?.type || 'network error',
      ]),
      body,
      ttfb: 0,
    }))
    xhrMeta.delete(this)
  }

  this.addEventListener('loadend', handleLoadEnd, { once: true })
  this.addEventListener('error', handleError, { once: true })
  this.addEventListener('abort', handleError, { once: true })
  this.addEventListener('timeout', handleError, { once: true })

  return originalXhrSend.apply(this, arguments)
}

try {
  window.fetch = interceptedFetch
} catch {
  // Some pages lock down fetch reassignment. XHR capture may still work.
}

try {
  XMLHttpRequest.prototype.open = interceptedXhrOpen
  XMLHttpRequest.prototype.setRequestHeader = interceptedXhrSetRequestHeader
  XMLHttpRequest.prototype.send = interceptedXhrSend
} catch {
  // Some pages lock down XHR prototypes. Fetch capture may still work.
}

window.setInterval(() => {
  const cutoff = performance.now() - 30000
  for (let index = pendingObservedRequests.length - 1; index >= 0; index -= 1) {
    if (pendingObservedRequests[index].startTime < cutoff) {
      pendingObservedRequests.splice(index, 1)
    }
  }
}, 10000)

async function replayRequest(requestId, request) {
  const startTime = performance.now()

  try {
    const headers = { ...(request.headers || {}) }
    const init = {
      method: request.method,
      headers,
      credentials: 'include',
      cache: 'no-store',
    }

    if (!['GET', 'HEAD'].includes(String(request.method).toUpperCase()) && request.body) {
      init.body = request.body
    }

    const response = await originalFetch(request.url, init)
    const responseHeaders = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    const contentType = response.headers.get('content-type') || ''
    const buffer = await response.clone().arrayBuffer()

    safePostMessage({
      source: 'api-debugger-injected',
      type: 'API_DEBUGGER_REPLAY_RESULT',
      requestId,
      payload: {
        status: response.status,
        duration: Math.round(performance.now() - startTime),
        responseBody: decodeCapturedBody(buffer, contentType),
        responseHeaders,
      },
    })
  } catch (error) {
    safePostMessage({
      source: 'api-debugger-injected',
      type: 'API_DEBUGGER_REPLAY_RESULT',
      requestId,
      payload: {
        status: 0,
        duration: Math.round(performance.now() - startTime),
        responseBody: String(error),
        responseHeaders: {},
      },
    })
  }
}
