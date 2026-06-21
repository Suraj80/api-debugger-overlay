# API Debugger Overlay Features

This document describes the major product surfaces and runtime behaviors in API Debugger Overlay.

## Overlay

The in-page overlay is the primary debugging surface. It is injected into the active page and rendered inside a Shadow DOM root so host page styles do not leak into the extension UI.

Core overlay features:

- live feed of captured `fetch` and XHR requests
- status, method, duration, request size, and response size visibility
- badges for slow requests, duplicate requests, and large payloads
- quick session stats such as total calls, average latency, and error rate
- pause, minimize, resume, clear session, and open side panel actions
- minimized state that can persist across pages when the user chooses it

## Request Inspection

Each request row can be expanded for deeper inspection.

Inspection features:

- request and response tabs
- JSON tree browsing
- key search
- expand all and collapse all
- copy JSON
- timing metadata such as TTFB and capture source
- duplicate group visibility

## Popup Settings

The popup is the configuration surface for the extension.

Settings include:

- enable or disable capture
- capture `fetch`
- capture XHR
- precise timing mode using Chrome debugger APIs
- slow request threshold
- large payload threshold
- overlay position
- overlay size preset: Large, Medium, or Small
- show overlay on page load
- OpenAI API key testing and saving

Regular settings are stored in `chrome.storage.sync`. The API key is encrypted and stored in `chrome.storage.local`.

## Side Panel

The side panel provides a larger analysis surface than the overlay.

It includes three main views:

- Session
- Dependency Map
- Replay

### Session View

The session view summarizes the current tab's captured traffic.

It includes:

- total request count
- average latency
- error rate
- latency timeline
- worst offenders list
- session report export

### Dependency Map

The dependency graph shows inferred request chains between endpoints.

Graph behavior:

- only connected endpoints are shown
- requests are aggregated by method and normalized endpoint across the full session
- large graphs show a ranked endpoint overview instead of hiding the graph
- the overview shows at most 10 numbered endpoints and prunes weaker crossing edges
- selecting an endpoint isolates its direct upstream and downstream neighbors
- node size reflects call frequency
- edge color reflects average latency
- visible nodes are intentionally capped for readability

### Replay View

Replay lets the user rerun a captured request through the original tab context so the page's cookies and authenticated session state are preserved.

Replay features:

- editable method, URL, headers, and body
- JSON formatting
- response comparison
- diff view between original and replayed response bodies

## AI Suggestions

The overlay can request AI help for slow or failing requests.

Current behavior:

- the user must explicitly click `Ask AI`
- sanitized request context is sent to OpenAI
- IDs, UUIDs, long values, and sensitive query parameters are generalized or removed
- requests are rate-limited in the background worker
- AI output is attached back to the captured request and displayed inline

## Session Handling

Session state is maintained per tab in the background service worker.

Important session behaviors:

- request history is kept in memory
- session data is cleared on tab close or navigation
- updates are broadcast to overlay and side panel surfaces
- duplicate detection is performed using normalized request fingerprints

## Dependency Inference

Dependency relationships are inferred heuristically rather than captured directly from the browser.

Signals used for inference include:

- timing proximity between requests
- shared identifiers in URLs
- shared values in request bodies
- shared values in parsed response bodies

The graph is intended as a debugging aid, not a strict source of truth.

## Export And Reporting

The side panel can export a session report as HTML.

The report includes:

- summary metrics
- latency timeline
- dependency map
- request feed table
- AI suggestions when present
- placeholders for payloads that were unavailable, oversized, binary, or restricted

## Request Replay

Replay is routed through the extension background worker and then executed back in the original tab context.

This design allows the replayed request to preserve the environment of the page being debugged, including cookies and active authenticated state, while avoiding a less accurate extension-only replay path.

## Capture Pipeline

The extension uses multiple layers to build request insight:

- injected page script for `fetch` and XHR interception
- content script bridge for message forwarding and UI mounting
- background service worker for session state, replay routing, AI, and side panel coordination
- optional Chrome debugger integration for more precise timing

## Privacy And Control

The extension is designed to keep captured data local unless the user explicitly chooses an action that requires sending data elsewhere.

User-controlled actions include:

- enabling or disabling capture
- clearing sessions
- replaying requests
- exporting reports
- testing or using AI

For the full privacy statement, see [privacy-policy.md](privacy-policy.md).
