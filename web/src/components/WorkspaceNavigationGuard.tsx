import { useMemo, useRef, useState, type ReactNode } from "react";
import { NavigationGuardContext, NavigationGuardPendingContext, type NavigationGuard } from "../hooks/navigation-guard-context";

export function WorkspaceNavigationGuard({ children }: { children: ReactNode }) {
  const active = useRef<NavigationGuard | null>(null);
  const approving = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const coordinator = useMemo(() => ({
    register(guard: NavigationGuard) {
      active.current = guard;
      setPending(true);
      return () => { if (active.current === guard) { active.current = null; setPending(false); } };
    },
    request(action: () => void) {
      if (active.current && !approving.current) active.current(action, returnFocus.current); else action();
    },
    runApproved(action: () => void) {
      const previous = approving.current;
      approving.current = true;
      try { action(); } finally { approving.current = previous; }
    },
    isActive() { return active.current !== null; },
    withReturnFocus(target: HTMLElement | null, action: () => void) {
      const previous = returnFocus.current;
      returnFocus.current = target;
      try { action(); } finally { returnFocus.current = previous; }
    },
  }), []);
  return <NavigationGuardContext.Provider value={coordinator}><NavigationGuardPendingContext.Provider value={pending}>{children}</NavigationGuardPendingContext.Provider></NavigationGuardContext.Provider>;
}
