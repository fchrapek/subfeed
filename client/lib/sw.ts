import { registerSW } from 'virtual:pwa-register'

// A new build waits until the user taps "Update", so it never reloads the page
// in the middle of a video.
export const UPDATE_READY_EVENT = 'subfeed:update-ready'

export const applyUpdate = registerSW({
  immediate: true,
  onNeedRefresh: () => window.dispatchEvent(new Event(UPDATE_READY_EVENT)),
})
