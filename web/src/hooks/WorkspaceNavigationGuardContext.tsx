import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  WorkspaceNavigationGuardContext,
  type WorkspaceNavigationAction,
  type WorkspaceNavigationCancelAction,
  type WorkspaceNavigationGuardId,
  type WorkspaceNavigationGuardRequest,
} from "./workspace-navigation-guard-context";

type NavigationOrigin = {
  path: string;
  historyIndex: number | null;
};

type GuardRegistration = {
  origin: NavigationOrigin;
  request: WorkspaceNavigationGuardRequest;
};

type HistoryTraversalPhase = "reversing" | "prompting" | "restoring-prompt" | "proceeding";

type PendingHistoryTraversal = {
  origin: NavigationOrigin;
  target: NavigationOrigin;
  delta: number;
  phase: HistoryTraversalPhase;
  focusOrigin: HTMLElement | null;
};

function currentNavigationOrigin(): NavigationOrigin {
  const historyIndex = typeof window.history.state?.idx === "number"
    ? window.history.state.idx
    : null;
  return {
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    historyIndex,
  };
}

function isCurrentOrigin(origin: NavigationOrigin, current: NavigationOrigin) {
  return origin.path === current.path && origin.historyIndex === current.historyIndex;
}

export function WorkspaceNavigationGuardProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const guardsRef = useRef(new Map<WorkspaceNavigationGuardId, GuardRegistration>());
  const approvedNavigationDepthRef = useRef(0);
  const settledOriginRef = useRef(currentNavigationOrigin());
  const pendingHistoryTraversalRef = useRef<PendingHistoryTraversal | null>(null);

  const registerGuard = useCallback((id: WorkspaceNavigationGuardId, request: WorkspaceNavigationGuardRequest) => {
    const registration = { origin: currentNavigationOrigin(), request };
    guardsRef.current.set(id, registration);
    return () => {
      if (guardsRef.current.get(id) === registration) guardsRef.current.delete(id);
    };
  }, []);

  const runApprovedNavigation = useCallback((action: WorkspaceNavigationAction) => {
    approvedNavigationDepthRef.current += 1;
    try {
      action();
    } finally {
      approvedNavigationDepthRef.current -= 1;
    }
  }, []);

  const requestGuardChain = useCallback((
    origin: NavigationOrigin,
    action: WorkspaceNavigationAction,
    onCancel?: WorkspaceNavigationCancelAction,
  ) => {
    const requestNextGuard = (skippedGuards: ReadonlySet<WorkspaceNavigationGuardId>) => {
      // Router history can move before a suspended destination commits. Keep a
      // hidden, departing route from swallowing a second workspace navigation.
      const nextGuard = [...guardsRef.current.entries()]
        .reverse()
        .find(([id, registration]) => (
          !skippedGuards.has(id) && isCurrentOrigin(registration.origin, origin)
        ));

      if (!nextGuard) {
        runApprovedNavigation(action);
        return;
      }

      const [id, registration] = nextGuard;
      registration.request(
        () => requestNextGuard(new Set([...skippedGuards, id])),
        onCancel,
      );
    };

    requestNextGuard(new Set());
  }, [runApprovedNavigation]);

  const restoreFocus = useCallback((origin: HTMLElement | null) => {
    window.requestAnimationFrame(() => {
      // Nested Radix surfaces release their focus scope after the guard dialog
      // closes. Restore on the following frame so that teardown cannot move
      // focus back to the workspace body or a departed overlay.
      window.requestAnimationFrame(() => {
        if (origin?.isConnected) origin.focus({ preventScroll: true });
      });
    });
  }, []);

  const requestNavigation = useCallback((action: WorkspaceNavigationAction) => {
    if (approvedNavigationDepthRef.current > 0) {
      action();
      return;
    }
    const activeElement = document.activeElement;
    const focusOrigin = activeElement instanceof HTMLElement ? activeElement : null;
    requestGuardChain(
      currentNavigationOrigin(),
      action,
      () => restoreFocus(focusOrigin),
    );
  }, [requestGuardChain, restoreFocus]);

  useEffect(() => {
    if (!pendingHistoryTraversalRef.current) {
      settledOriginRef.current = currentNavigationOrigin();
    }
  }, [location.hash, location.key, location.pathname, location.search]);

  // This provider is mounted as BrowserRouter's immediate child. Registering
  // during the descendant layout phase lets the coordinator observe and stop a
  // POP before BrowserRouter commits the destination route.
  useLayoutEffect(() => {
    const interceptHistoryTraversal = (event: PopStateEvent) => {
      const nextOrigin = currentNavigationOrigin();
      const pending = pendingHistoryTraversalRef.current;

      if (pending?.phase === "proceeding") {
        pendingHistoryTraversalRef.current = null;
        settledOriginRef.current = nextOrigin;
        return;
      }

      if (pending?.phase === "reversing") {
        event.stopImmediatePropagation();
        if (!isCurrentOrigin(nextOrigin, pending.origin)) {
          if (pending.origin.historyIndex !== null && nextOrigin.historyIndex !== null) {
            window.history.go(pending.origin.historyIndex - nextOrigin.historyIndex);
          }
          return;
        }

        pending.phase = "prompting";
        settledOriginRef.current = pending.origin;
        window.requestAnimationFrame(() => {
          if (pendingHistoryTraversalRef.current !== pending || pending.phase !== "prompting") return;
          requestGuardChain(
            pending.origin,
            () => {
              if (pendingHistoryTraversalRef.current !== pending) return;
              pending.phase = "proceeding";
              window.history.go(pending.delta);
            },
            () => {
              if (pendingHistoryTraversalRef.current !== pending) return;
              pendingHistoryTraversalRef.current = null;
              settledOriginRef.current = pending.origin;
              restoreFocus(pending.focusOrigin);
            },
          );
        });
        return;
      }

      if (pending?.phase === "restoring-prompt") {
        event.stopImmediatePropagation();
        if (isCurrentOrigin(nextOrigin, pending.origin)) {
          pending.phase = "prompting";
          settledOriginRef.current = pending.origin;
        } else if (pending.origin.historyIndex !== null && nextOrigin.historyIndex !== null) {
          window.history.go(pending.origin.historyIndex - nextOrigin.historyIndex);
        }
        return;
      }

      if (pending?.phase === "prompting") {
        event.stopImmediatePropagation();
        if (pending.origin.historyIndex !== null && nextOrigin.historyIndex !== null) {
          pending.phase = "restoring-prompt";
          window.history.go(pending.origin.historyIndex - nextOrigin.historyIndex);
        }
        return;
      }

      const origin = settledOriginRef.current;
      const hasOriginGuard = [...guardsRef.current.values()]
        .some((registration) => isCurrentOrigin(registration.origin, origin));
      const canReverse = origin.historyIndex !== null
        && nextOrigin.historyIndex !== null
        && origin.historyIndex !== nextOrigin.historyIndex;

      if (!hasOriginGuard || !canReverse) {
        settledOriginRef.current = nextOrigin;
        return;
      }

      event.stopImmediatePropagation();
      const activeElement = document.activeElement;
      const traversal: PendingHistoryTraversal = {
        origin,
        target: nextOrigin,
        delta: nextOrigin.historyIndex! - origin.historyIndex!,
        phase: "reversing",
        focusOrigin: activeElement instanceof HTMLElement ? activeElement : null,
      };
      pendingHistoryTraversalRef.current = traversal;
      window.history.go(-traversal.delta);
    };

    window.addEventListener("popstate", interceptHistoryTraversal, true);
    return () => window.removeEventListener("popstate", interceptHistoryTraversal, true);
  }, [requestGuardChain, restoreFocus]);

  const value = useMemo(
    () => ({ registerGuard, requestNavigation }),
    [registerGuard, requestNavigation],
  );

  return (
    <WorkspaceNavigationGuardContext.Provider value={value}>
      {children}
    </WorkspaceNavigationGuardContext.Provider>
  );
}
