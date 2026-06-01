import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AISuggestionRequest } from '../../src/shared/types'

function installChromeMock() {
  const addListener = vi.fn()

  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: {
        id: 'test-extension-id',
        onInstalled: { addListener },
        onMessage: { addListener },
        sendMessage: vi.fn(() => Promise.resolve()),
      },
      debugger: {
        attach: vi.fn(() => Promise.resolve()),
        detach: vi.fn(() => Promise.resolve()),
        sendCommand: vi.fn(() => Promise.resolve()),
        onDetach: { addListener },
        onEvent: { addListener },
      },
      tabs: {
        query: vi.fn(() => Promise.resolve([])),
        sendMessage: vi.fn(() => Promise.resolve()),
        onActivated: { addListener },
        onRemoved: { addListener },
        onUpdated: { addListener },
      },
      webRequest: {
        onCompleted: { addListener },
      },
      sidePanel: {
        open: vi.fn(() => Promise.resolve()),
      },
      storage: {
        sync: {
          get: vi.fn(() => Promise.resolve({})),
          set: vi.fn(() => Promise.resolve()),
        },
        local: {
          get: vi.fn(() => Promise.resolve({})),
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => Promise.resolve()),
        },
      },
    },
    configurable: true,
  })
}

const request: AISuggestionRequest = {
  id: 'request-1',
  method: 'GET',
  url: 'https://api.example.com/users/123/orders/550e8400-e29b-41d4-a716-446655440000?token=secret&page=2&filter=active',
  status: 200,
  duration: 1800,
  ttfb: 900,
  responseSize: 640000,
  isSlow: true,
  isDuplicate: true,
  duplicateCount: 3,
  dependsOnCount: 1,
}

const normalRequest: AISuggestionRequest = {
  id: 'request-2',
  method: 'POST',
  url: 'https://api.example.com/user/state?view=dashboard',
  status: 200,
  duration: 220,
  ttfb: 80,
  responseSize: 4096,
  isSlow: false,
  isDuplicate: false,
  duplicateCount: 1,
  dependsOnCount: 0,
}

describe('background AI helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    installChromeMock()
  })

  it('builds a sanitized, specific AI prompt', async () => {
    const { buildAiSuggestionPrompt } = await import('../../src/background/index')

    const prompt = buildAiSuggestionPrompt(request)

    expect(prompt).toContain('flagged as slow')
    expect(prompt).toContain('Method: GET')
    expect(prompt).toContain('/users/:id/orders/:uuid')
    expect(prompt).toContain('page=%3Aid')
    expect(prompt).toContain('filter=active')
    expect(prompt).not.toContain('token=secret')
    expect(prompt).not.toContain('550e8400-e29b-41d4-a716-446655440000')
    expect(prompt).toContain('called 3 times')
    expect(prompt).toContain('dependency chain')
  })

  it('builds a general explanation prompt for healthy requests', async () => {
    const { buildAiSuggestionPrompt } = await import('../../src/background/index')

    const prompt = buildAiSuggestionPrompt(normalRequest)

    expect(prompt).toContain('A developer wants help understanding an API request.')
    expect(prompt).toContain('Method: POST')
    expect(prompt).toContain('/user/state?view=dashboard')
    expect(prompt).toContain('For "General info", explain what the API likely does')
    expect(prompt).not.toContain('flagged as slow')
    expect(prompt).not.toContain('suggest one specific fix')
  })

  it('parses text from a raw Responses API output array', async () => {
    const { parseOpenAiText } = await import('../../src/background/index')

    const text = parseOpenAiText({
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Likely caused by repeated auth revalidation.' },
            { type: 'output_text', text: 'Cache the user state request for this route.' },
          ],
        },
      ],
    })

    expect(text).toContain('repeated auth revalidation')
    expect(text).toContain('Cache the user state request')
  })
})
