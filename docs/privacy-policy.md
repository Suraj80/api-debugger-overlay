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

When the optional precise timing mode is enabled, the extension may also use Chrome's debugger APIs to collect more detailed network timing information for the active tab.

## How data is used

- Captured request data is used to render the in-page overlay and side panel.
- Session data is stored in memory for the current tab session.
- Captured request data can be used to populate the replay editor when the user chooses to replay a request.
- Replay requests are executed only when the user explicitly triggers them, and they run in the original tab context so the page's existing cookies and authenticated session state can be preserved.
- Exported session reports are generated only when the user explicitly requests an export.
- Exported session reports are saved locally through Chrome's download APIs only when the user explicitly requests an export.
- AI suggestions are requested only when the user explicitly clicks `Ask AI`.
- AI connection tests are requested only when the user explicitly uses the connection test in settings.

## What is stored

- General extension settings are stored in `chrome.storage.sync`.
- The optional Anthropic API key is stored encrypted in `chrome.storage.local`.
- Captured session data is kept in in-memory per-tab session state and is not written to extension storage unless the user explicitly exports a report.

## External services

No captured request data is sent to external services unless the user explicitly triggers an AI feature.

When an AI feature is used:

- the extension may send either a minimal test request or sanitized request context to `api.anthropic.com`
- sensitive query parameters such as tokens, keys, passwords, auth values, and sessions are removed from the AI prompt
- path segments that look like identifiers may be generalized before sending

## Permissions and access

The extension requests access needed to debug API activity on pages the user chooses to inspect.

- `<all_urls>` host access is used so the extension can observe API traffic on the current page.
- `webRequest` is used to enrich captured request status information.
- `sidePanel` is used to show the session dashboard, dependency graph, and replay tools.
- `downloads` is used only when the user exports a session report.
- `debugger` is used only for the optional precise timing mode and may cause Chrome to show its standard debugging banner.

## Data sharing

The extension does not sell captured data or use it for advertising.

## User control

Users can:

- disable capture
- limit capture scope through settings
- disable precise mode
- clear the current tab session
- choose whether to configure an API key
- choose whether to use AI suggestions or connection tests
- choose whether to replay requests or export reports

## Contact / project source

Refer to the project repository and release documentation for the current source of truth for this extension.
