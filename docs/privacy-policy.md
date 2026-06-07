# Privacy Policy

API Debugger Overlay is a developer tool. It processes captured API request data locally in the browser to help the user inspect traffic on pages they are actively debugging.

## What the extension captures

When capture is enabled, the extension may collect data about `fetch` and XHR requests on the current page, including:

- request URL and HTTP method
- response status
- timing metadata such as duration, TTFB, and capture source
- request and response headers
- request and response bodies when the payload is text-like and available to the extension
- payload-size metadata
- duplicate-request fingerprints
- inferred dependency relationships between requests

When optional precise timing mode is enabled, the extension may also use Chrome's `debugger` APIs to collect more detailed network timing information for the active tab.

## How data is used

- Captured request data is used to render the in-page overlay and the side panel.
- Session data is maintained in memory per tracked browser tab.
- Captured request data may be used to populate the replay editor.
- Replay requests are executed only when the user explicitly triggers replay.
- A replay is sent back to the original destination from the original tab context, which means the page's existing cookies, authentication state, headers, and request body may be used as part of that user-triggered action.
- Exported session reports are generated only when the user explicitly requests an export.
- Exported reports are saved locally through Chrome's download APIs only when the user explicitly requests an export.
- AI suggestions are requested only when the user explicitly clicks `Ask AI`.
- AI connection tests are requested only when the user explicitly uses the connection test in settings.

## What is stored

- General extension settings are stored in `chrome.storage.sync`.
- The optional OpenAI API key is stored encrypted in `chrome.storage.local`.
- Captured session data is kept in in-memory per-tab session state.
- Captured request history is not written to extension storage unless the user explicitly exports a report.

## External services

The extension does not automatically send captured traffic to third-party services.

Data leaves the browser only when the user explicitly triggers an action that requires it, such as:

- replaying a request back to its original destination
- testing the OpenAI connection
- requesting an AI suggestion

When an AI feature is used:

- the extension sends either a minimal test request or sanitized request context to `api.openai.com`
- the sanitized AI context may include method, endpoint, status, timing, response-size, duplicate-call, and dependency-chain information
- sensitive query parameters such as tokens, keys, passwords, auth values, and sessions are removed from the AI prompt
- path segments that look like identifiers may be generalized before sending
- request and response bodies are not included in the current AI prompt

## Permissions and access

The extension requests access needed to debug API activity on pages the user chooses to inspect.

- `<all_urls>` host access allows the extension to observe API traffic on the active page.
- `webRequest` is used to enrich captured request status information.
- `sidePanel` is used to show the larger analysis workspace.
- `downloads` is used only when the user exports a session report.
- `debugger` is used only for optional precise timing mode and may cause Chrome to show its standard debugging banner.
- `storage` is used to persist settings and the encrypted API key.

## Data retention

- Session data is cleared when the tracked tab is closed.
- Session data is also reset when the tracked page navigates.
- Exported reports remain wherever the user saves them locally.

## Data sharing

The extension does not sell captured data, use it for advertising, or share it with third parties except when the user explicitly triggers AI or replay behavior described above.

## User control

Users can:

- enable or disable capture
- choose whether to capture `fetch` and/or XHR
- enable or disable precise timing mode
- configure overlay behavior and visibility
- clear the current tab session
- choose whether to configure an OpenAI API key
- choose whether to use AI suggestions or connection tests
- choose whether to replay requests
- choose whether to export reports

## Contact / project source

Refer to the project repository and release documentation for the current source of truth for this extension.
