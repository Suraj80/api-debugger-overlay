// Runs in page context - has access to real window.fetch and XHR.
// Only bridge to extension: window.postMessage.

const originalFetch = window.fetch.bind(window)
const originalXhrOpen = XMLHttpRequest.prototype.open
const originalXhrSend = XMLHttpRequest.prototype.send
const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader

const SLOW_REQUEST_THRESHOLD_MS = 1500
const xhrMeta = new WeakMap()
const seenFingerprints = new Set()

function createRequestEntry({
  url,
  method,
  status,
  duration,
  startTime,
  requestSize = 0,
  requestHeaders = {},
  body = null,
}) {
  const fingerprint = createFingerprint(method, url, body)
  const isDuplicate = seenFingerprints.has(fingerprint)

  seenFingerprints.add(fingerprint)

  return {
    id: crypto.randomUUID(),
    url,
    method,
    status,
    duration,
    startTime,
    requestSize,
    responseSize: 0,
    requestHeaders,
    responseBody: null,
    isDuplicate,
    isSlow: duration > SLOW_REQUEST_THRESHOLD_MS,
    aiSuggestion: null,
    dependsOn: [],
    fingerprint,
    ttfb: 0,
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
  const startTime = performance.now()
  const url = input instanceof Request ? input.url : input.toString()
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

  try {
    const response = await originalFetch(input, init)
    const duration = Math.round(performance.now() - startTime)

    postRequestComplete(createRequestEntry({
        url,
        method,
        status: response.status,
        duration,
        startTime,
        requestSize: getBodySize(init?.body),
        body: init?.body,
      }))

    return response
  } catch (error) {
    postRequestFailed({ url, method, error: String(error) })
    throw error
  }
}

XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
  xhrMeta.set(this, {
    method: String(method || 'GET').toUpperCase(),
    url: String(url),
    requestHeaders: {},
    startTime: 0,
    requestSize: 0,
  })

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

  if (!meta) {
    return originalXhrSend.apply(this, arguments)
  }

  meta.startTime = performance.now()
  meta.requestSize = getBodySize(body)

  const handleLoadEnd = () => {
    const duration = Math.round(performance.now() - meta.startTime)

    postRequestComplete(createRequestEntry({
      url: meta.url,
      method: meta.method,
      status: this.status,
      duration,
      startTime: meta.startTime,
      requestSize: meta.requestSize,
      requestHeaders: meta.requestHeaders,
      body,
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
