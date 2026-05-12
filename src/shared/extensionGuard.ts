export function isExtensionContextValid() {
  try {
    return Boolean(chrome.runtime?.id)
  } catch {
    return false
  }
}
