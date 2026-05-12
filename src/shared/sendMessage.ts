import { isExtensionContextValid } from './extensionGuard'

export async function sendRuntimeMessage(message: unknown): Promise<unknown> {
  if (!isExtensionContextValid()) return

  try {
    return await chrome.runtime.sendMessage(message)
  } catch (err) {
    console.warn('[API Debugger] sendRuntimeMessage failed:', err)
  }
}
