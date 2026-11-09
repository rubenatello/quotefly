type PopStateGuard = (event: PopStateEvent) => void;
let activeGuard: PopStateGuard | null = null;
let installed = false;

/** Install before BrowserRouter: listeners on window run in registration order. */
export function installHistoryNavigationGuard() {
  if (installed) return;
  installed = true;
  window.addEventListener("popstate", event => activeGuard?.(event));
}

export function registerHistoryNavigationGuard(guard: PopStateGuard) {
  activeGuard = guard;
  return () => { if (activeGuard === guard) activeGuard = null; };
}
