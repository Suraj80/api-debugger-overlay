export interface RequestEntry {
  id: string
  url: string
  method: string
  status: number
  duration: number
  startTime: number
  requestSize: number
  responseSize: number
  requestHeaders: Record<string, string>
  responseBody: string | null
  isDuplicate: boolean
  isSlow: boolean
  aiSuggestion: string | null
  dependsOn: string[]
  fingerprint: string
  ttfb: number
}

export type ExtensionMessage =
  | { type: 'REQUEST_COMPLETE'; payload: RequestEntry }
  | { type: 'REQUEST_FAILED'; payload: { url: string; error: string } }
  | { type: 'CLEAR_SESSION' }
