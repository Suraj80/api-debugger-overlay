// MV3 service worker — no DOM, no window object
// Central message hub for the extension

chrome.runtime.onInstalled.addListener(() => {
  console.log('API Debugger installed successfully')
})

// Route messages from content script back to the overlay
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab?.id) return

  if (
    message.type === 'REQUEST_COMPLETE' ||
    message.type === 'REQUEST_FAILED'
  ) {
    // Forward back to content script on the same tab
    chrome.tabs.sendMessage(sender.tab.id, message).catch(() => {
      // Tab may have navigated or closed — safe to ignore
    })
  }
})
