// Runs in page context — has access to real window.fetch and XHR
// Injected before any page scripts via web_accessible_resources
// Only bridge to extension: window.postMessage

const originalFetch = window.fetch.bind(window)

window.fetch = async (input: RequestInfo, init?: RequestInit) => {
  const startTime = performance.now()
  const url = input instanceof Request ? input.url : input.toString()
  const method = (init?.method ?? 'GET').toUpperCase()

  try {
    const response = await originalFetch(input, init)
    const duration = Math.round(performance.now() - startTime)

    window.postMessage({
      source: 'api-debugger-injected',
      type: 'REQUEST_COMPLETE',
      payload: {
        id: crypto.randomUUID(),
        url,
        method,
        status: response.status,
        duration,
        startTime,
        requestSize: 0,
        responseSize: 0,
        requestHeaders: {},
        responseBody: null,
        isDuplicate: false,
        isSlow: false,
        aiSuggestion: null,
        dependsOn: [],
        fingerprint: '',
        ttfb: 0,
      }
    }, '*')

    return response
  } catch (error) {
    window.postMessage({
      source: 'api-debugger-injected',
      type: 'REQUEST_FAILED',
      payload: { url, method, error: String(error) }
    }, '*')
    throw error
  }
}
