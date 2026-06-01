export type TimingSource = 'proxy' | 'performance' | 'cdp'

export interface RequestEntry {
  id: string
  url: string
  method: string
  status: number
  duration: number
  startTime: number
  requestSize: number
  responseSize: number
  decodedBodySize: number
  transferSize: number
  requestHeaders: Record<string, string>
  requestBody: string | null
  responseBody: string | null
  isDuplicate: boolean
  duplicateOf: string | null
  duplicateCount: number
  isSlow: boolean
  aiSuggestion: string | null
  dependsOn: string[]
  fingerprint: string
  ttfb: number
  dnsTime: number
  connectTime: number
  sslTime: number
  requestTime: number
  responseTime: number
  timingSource: TimingSource
}

export interface TimingUpdatePayload {
  id: string
  url: string
  duration: number
  startTime: number
  ttfb: number
  dnsTime: number
  connectTime: number
  sslTime: number
  requestTime: number
  responseTime: number
  responseSize: number
  decodedBodySize: number
  transferSize: number
  timingSource: TimingSource
}

export interface ReplayRequest {
  id: string
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  originalResponseBody: string | null
  jobId?: string
}

export interface ReplayResult {
  status: number
  duration: number
  responseBody: string | null
  responseHeaders: Record<string, string>
}

export interface ReplayAck {
  ok: boolean
  jobId: string
}

export type ReplayPhase = 'started' | 'headers' | 'complete' | 'error'

export interface ReplayProgressPayload {
  jobId: string
  phase: ReplayPhase
  result?: ReplayResult
}

export interface AISuggestionRequest {
  id: string
  method: string
  url: string
  status: number
  duration: number
  ttfb: number
  responseSize: number
  isSlow: boolean
  isDuplicate: boolean
  duplicateCount: number
  dependsOnCount: number
}

export interface AISuggestionResponse {
  ok: boolean
  suggestion?: string
  error?: string
  retryAfterMs?: number
}

export type ExtensionMessage =
  | { type: 'REQUEST_COMPLETE'; payload: RequestEntry }
  | { type: 'REQUEST_UPDATED'; payload: RequestEntry }
  | { type: 'TIMING_UPDATE'; payload: TimingUpdatePayload }
  | { type: 'GET_OVERLAY_STATE'; tabId?: number }
  | { type: 'SET_OVERLAY_PAUSED'; payload: { paused: boolean } }
  | { type: 'SET_PRECISE_MODE'; payload: { enabled: boolean } }
  | { type: 'ASK_AI_SUGGESTION'; payload: AISuggestionRequest }
  | { type: 'TEST_AI_CONNECTION' }
  | { type: 'REQUEST_FAILED'; payload: { url: string; error: string } }
  | { type: 'CLEAR_SESSION' }
  | { type: 'GET_SESSION'; tabId?: number }
  | { type: 'SESSION_UPDATED'; tabId: number; payload: RequestEntry[] }
  | { type: 'DEPENDENCIES_UPDATED'; payload: { requestId: string; dependsOn: string[] } }
  | { type: 'SELECT_REPLAY'; payload: ReplayRequest }
  | { type: 'GET_REPLAY_TARGET'; tabId?: number }
  | { type: 'REPLAY_TARGET_SELECTED'; tabId: number; payload: ReplayRequest }
  | { type: 'REPLAY_PROGRESS'; tabId: number; payload: ReplayProgressPayload }
  | { type: 'RUN_REPLAY'; tabId: number; payload: ReplayRequest }
  | { type: 'EXECUTE_REPLAY'; payload: ReplayRequest }
  | { type: 'OPEN_SIDE_PANEL' }

export interface SessionSnapshot {
  tabId: number | null
  tabLabel?: string | null
  requests: RequestEntry[]
}

export interface ReplayTargetSnapshot {
  tabId: number | null
  request: ReplayRequest | null
}

export interface OverlayStateSnapshot {
  tabId: number | null
  paused: boolean
}
