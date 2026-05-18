import { isExtensionContextValid } from './extensionGuard'

function isIgnorableRuntimeError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message)
        : ''

  return (
    message.includes('The page keeping the extension port is moved into back/forward cache') ||
    message.includes('Extension context invalidated') ||
    message.includes('Receiving end does not exist') ||
    message.includes('message port closed')
  )
}

export async function sendRuntimeMessage(message: unknown): Promise<unknown> {
  if (!isExtensionContextValid()) return
  if (document.visibilityState === 'hidden') return

  try {
    return await chrome.runtime.sendMessage(message)
  } catch (err) {
    if (isIgnorableRuntimeError(err)) return
    console.warn('[API Debugger] sendRuntimeMessage failed:', err)
  }
}
