// Overlays (player, sheets, an open playlist) sit on the browser history, so the
// Android back button and the iOS edge swipe close the top layer instead of
// leaving the app. Layers are pushed from event handlers, never from effects,
// so StrictMode's double effects can't desync the history stack.

const stack: (() => void)[] = []
// popstate events caused by our own history.back() in popLayer, already handled.
let skip = 0

// A reload leaves our entries behind; without this, Back would do nothing once.
if ((history.state as { subfeedLayer?: number } | null)?.subfeedLayer) history.replaceState(null, '')

window.addEventListener('popstate', () => {
  if (skip) {
    skip--
    return
  }
  stack.pop()?.()
})

/** Register an open layer; `close` runs when the user goes back. */
export function pushLayer(close: () => void): void {
  stack.push(close)
  history.pushState({ subfeedLayer: stack.length }, '')
}

/**
 * Close the top layer the same way the back button would. Closes synchronously,
 * so a double tap can't take a second layer down with it.
 */
export function popLayer(): void {
  const close = stack.pop()
  if (!close) return
  skip++
  close()
  history.back()
}

export const layerDepth = () => stack.length
