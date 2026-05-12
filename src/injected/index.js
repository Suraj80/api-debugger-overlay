// Runs in page context - has access to real window.fetch and XHR.
// Only bridge to extension: window.postMessage.

const originalFetch = window.fetch.bind(window)
const originalXhrOpen = XMLHttpRequest.prototype.open
const originalXhrSend = XMLHttpRequest.prototype.send
const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  captureFetch: true,
  captureXHR: true,
  slowRequestThresholdMs: 1500,
  largePayloadThresholdKb: 500,
}
let settings = { ...DEFAULT_SETTINGS }
const xhrMeta = new WeakMap()
const MAX_FINGERPRINTS = 1000
const seenFingerprints = new Set()
const performanceEntries = []
const MAX_PERFORMANCE_ENTRIES = 300

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
    id: crypto.randomUUID(),
    url,
    method,
    status,
    duration,
    startTime,
    requestSize,
    responseSize,
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
  }
}

function rememberPerformanceEntries(entries) {
  performanceEntries.push(...entries)

  if (performanceEntries.length > MAX_PERFORMANCE_ENTRIES) {
    performanceEntries.splice(0, performanceEntries.length - MAX_PERFORMANCE_ENTRIES)
  }
}

function startPerformanceObserver() {
  try {
    rememberPerformanceEntries(performance.getEntriesByType('resource'))

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

async function captureFetchResponsePayload(response) {
  try {
    const contentType = response.headers?.get?.('content-type') || ''
    const buffer = await response.clone().arrayBuffer()

    return {
      responseSize: buffer.byteLength,
      responseBody: decodeCapturedBody(buffer, contentType),
    }
  } catch {
    return {
      responseSize: 0,
      responseBody: null,
    }
  }
}

function captureXhrResponsePayload(xhr) {
  try {
    const contentType = xhr.getResponseHeader?.('content-type') || ''

    if (xhr.responseType === '' || xhr.responseType === 'text') {
      const responseBody = xhr.responseText ?? ''

      return {
        responseSize: getBodySize(responseBody),
        responseBody: isTextLikeContentType(contentType) ? responseBody : null,
      }
    }

    if (xhr.responseType === 'json') {
      const responseBody = xhr.response == null ? null : JSON.stringify(xhr.response)

      return {
        responseSize: getBodySize(responseBody),
        responseBody,
      }
    }

    if (xhr.response instanceof ArrayBuffer) {
      return {
        responseSize: xhr.response.byteLength,
        responseBody: decodeCapturedBody(xhr.response, contentType),
      }
    }

    if (xhr.response instanceof Blob) {
      return {
        responseSize: xhr.response.size,
        responseBody: null,
      }
    }

    return {
      responseSize: getBodySize(xhr.response),
      responseBody: null,
    }
  } catch {
    return {
      responseSize: 0,
      responseBody: null,
    }
  }
}

function postRequestComplete(entry) {
  window.postMessage({
    source: 'api-debugger-injected',
    type: 'REQUEST_COMPLETE',
    payload: entry
  }, '*')
}

function postRequestFailed(payload) {
  window.postMessage({
    source: 'api-debugger-injected',
    type: 'REQUEST_FAILED',
    payload
  }, '*')
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

function getRequestTiming(url, startTime, initiatorTypes) {
  const href = absoluteUrl(url)
  const allowedInitiators = new Set(initiatorTypes)
  let bestEntry = null
  let bestDelta = Number.POSITIVE_INFINITY

  for (let index = performanceEntries.length - 1; index >= 0; index -= 1) {
    const entry = performanceEntries[index]
    if (entry.name !== href) continue
    if (allowedInitiators.size > 0 && !allowedInitiators.has(entry.initiatorType)) continue

    const delta = Math.abs(entry.startTime - startTime)
    if (delta < bestDelta) {
      bestEntry = entry
      bestDelta = delta
    }
  }

  if (!bestEntry || bestDelta > 250) {
    return { ttfb: 0 }
  }

  return {
    ttfb: bestEntry.responseStart > 0
      ? Math.max(0, Math.round(bestEntry.responseStart - bestEntry.startTime))
      : 0,
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

window.fetch = async (input, init) => {
  if (!settings.captureEnabled || !settings.captureFetch) {
    return originalFetch(input, init)
  }

  const startTime = performance.now()
  const url = input instanceof Request ? input.url : input.toString()
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const requestHeaders = mergeHeaders(input instanceof Request ? input.headers : null, init?.headers)
  const requestBodySource = init?.body ?? await readRequestBody(input)
  const requestBody = bodyToReplayString(requestBodySource)

  try {
    const response = await originalFetch(input, init)
    const duration = Math.round(performance.now() - startTime)
    const requestSize = getBodySize(requestBodySource)

    captureFetchResponsePayload(response).then(({ responseSize, responseBody }) => {
      const timing = getRequestTiming(url, startTime, ['fetch'])

      postRequestComplete(createRequestEntry({
        url,
        method,
        status: response.status,
        duration,
        startTime,
        requestSize,
        requestHeaders,
        requestBody,
        responseSize,
        responseBody,
        body: requestBodySource,
        ttfb: timing.ttfb,
      }))
    })

    return response
  } catch (error) {
    postRequestFailed({ url, method, error: String(error) })
    throw error
  }
}

XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
  if (settings.captureEnabled && settings.captureXHR) {
    xhrMeta.set(this, {
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

XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  const meta = xhrMeta.get(this)

  if (meta) {
    meta.requestHeaders[String(name)] = String(value)
  }

  return originalXhrSetRequestHeader.apply(this, arguments)
}

XMLHttpRequest.prototype.send = function (body) {
  const meta = xhrMeta.get(this)

  if (!meta || !settings.captureEnabled || !settings.captureXHR) {
    xhrMeta.delete(this)
    return originalXhrSend.apply(this, arguments)
  }

  meta.startTime = performance.now()
  meta.requestSize = getBodySize(body)
  meta.requestBody = bodyToReplayString(body)

  const handleLoadEnd = () => {
    const duration = Math.round(performance.now() - meta.startTime)
    const { responseSize, responseBody } = captureXhrResponsePayload(this)
    const timing = getRequestTiming(meta.url, meta.startTime, ['xmlhttprequest'])

    postRequestComplete(createRequestEntry({
      url: meta.url,
      method: meta.method,
      status: this.status,
      duration,
      startTime: meta.startTime,
      requestSize: meta.requestSize,
      requestHeaders: meta.requestHeaders,
      requestBody: meta.requestBody,
      responseSize,
      responseBody,
      body,
      ttfb: timing.ttfb,
    }))

    xhrMeta.delete(this)
  }

  const handleError = () => {
    postRequestFailed({
      url: meta.url,
      method: meta.method,
      error: 'XMLHttpRequest failed'
    })
  }

  this.addEventListener('loadend', handleLoadEnd, { once: true })
  this.addEventListener('error', handleError, { once: true })
  this.addEventListener('abort', handleError, { once: true })
  this.addEventListener('timeout', handleError, { once: true })

  return originalXhrSend.apply(this, arguments)
}

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

    window.postMessage({
      source: 'api-debugger-injected',
      type: 'API_DEBUGGER_REPLAY_RESULT',
      requestId,
      payload: {
        status: response.status,
        duration: Math.round(performance.now() - startTime),
        responseBody: decodeCapturedBody(buffer, contentType),
        responseHeaders,
      },
    }, '*')
  } catch (error) {
    window.postMessage({
      source: 'api-debugger-injected',
      type: 'API_DEBUGGER_REPLAY_RESULT',
      requestId,
      payload: {
        status: 0,
        duration: Math.round(performance.now() - startTime),
        responseBody: String(error),
        responseHeaders: {},
      },
    }, '*')
  }
}
