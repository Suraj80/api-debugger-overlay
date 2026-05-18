# Privacy Policy

API Debugger Overlay processes network request data locally in the browser to help users inspect API behavior on pages they are actively debugging.

## What the extension captures

When enabled, the extension may capture:

- request URL and method
- response status
- timing metadata such as duration and TTFB
- request and response headers
- request and response bodies when the payload is text-like and within configured capture limits
- duplicate-request fingerprints and inferred dependency relationships

## How data is used

- Captured request data is used to render the in-page overlay and side panel.
- Session data is stored in memory for the current tab session.
- Exported session reports are generated only when the user explicitly requests an export.
- AI suggestions are requested only when the user explicitly clicks `Ask AI`.

## What is stored

- General extension settings are stored in `chrome.storage.sync`.
- The optional Anthropic API key is stored encrypted in `chrome.storage.local`.
- Captured session data is not persisted as a long-term background database by default.

## External services

No captured request data is sent to external services unless the user explicitly triggers the AI suggestion feature.

When the AI suggestion feature is used:

- sanitized request context is sent to `api.anthropic.com`
- sensitive query parameters such as tokens, keys, passwords, auth values, and sessions are removed from the AI prompt
- path segments that look like identifiers may be generalized before sending

## Data sharing

The extension does not sell captured data or use it for advertising.

## User control

Users can:

- disable capture
- limit capture scope through settings
- disable precise mode
- clear the current tab session
- choose whether to configure an API key

## Contact / project source

Refer to the project repository and release documentation for the current source of truth for this extension.
