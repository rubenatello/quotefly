import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBeforeUnload, useNavigate } from "react-router-dom";
import { NavigationGuardContext } from "./navigation-guard-context";
import { registerHistoryNavigationGuard } from "./history-navigation-guard";

type PendingNavigation = (() => void) | null;

interface UnsavedChangesGuardOptions {
  historyPrompt?: string;
  blockNavigation?: boolean;
}

export function useUnsavedChangesGuard(when: boolean, options: UnsavedChangesGuardOptions = {}) {
  const navigate = useNavigate();
  const coordinator = useContext(NavigationGuardContext);
  const blockNavigation = options.blockNavigation ?? false;
  const historyPrompt =
    options.historyPrompt ?? "You have unsaved quote changes. Leave this page and keep the browser recovery draft?";
  const pendingNavigationRef = useRef<PendingNavigation>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const historyIndexRef = useRef<number | null>(
    typeof window !== "undefined" && typeof window.history.state?.idx === "number" ? window.history.state.idx : null,
  );
  const reversingPopRef = useRef(false);
  const [prompt, setPrompt] = useState<"navigation" | "blocked-history" | null>(null);
  // The blocked Back traversal was already reversed. Clear its informational
  // state when saving settles; a queued SPA action remains confirmable.
  if (prompt === "blocked-history" && !blockNavigation) setPrompt(null);
  const navigationPromptOpen = prompt !== null && (prompt !== "blocked-history" || blockNavigation);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!when) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [when],
    ),
  );

  const requestNavigation = useCallback(
    (action: () => void, returnFocus?: HTMLElement | null) => {
      if (!when) {
        action();
        return;
      }
      pendingNavigationRef.current = action;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const menuTriggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
      returnFocusRef.current = returnFocus ?? (menuTriggerId ? document.getElementById(menuTriggerId) : active);
      setPrompt("navigation");
    },
    [when],
  );

  useLayoutEffect(() => {
    if (when && coordinator) return coordinator.register(requestNavigation);
  }, [when, coordinator, requestNavigation]);

  useEffect(() => {
    if (!when) return;

    const interceptLinkNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const nextPath = `${destination.pathname}${destination.search}${destination.hash}`;
      if (nextPath === currentPath) return;

      event.preventDefault();
      event.stopPropagation();
      requestNavigation(() => navigate(nextPath));
    };

    document.addEventListener("click", interceptLinkNavigation, true);
    return () => document.removeEventListener("click", interceptLinkNavigation, true);
  }, [navigate, requestNavigation, when]);

  useLayoutEffect(() => {
    historyIndexRef.current = typeof window.history.state?.idx === "number" ? window.history.state.idx : null;
    if (!when) return;

    const interceptHistoryTraversal = (event: PopStateEvent) => {
      const nextIndex = typeof window.history.state?.idx === "number" ? window.history.state.idx : null;
      if (reversingPopRef.current) {
        event.stopImmediatePropagation();
        reversingPopRef.current = false;
        historyIndexRef.current = nextIndex;
        return;
      }

      // A submitted save cannot be discarded by unmounting its form. Keep the
      // route mounted until its outcome is known, including browser Back.
      if (blockNavigation) {
        pendingNavigationRef.current = null;
        setPrompt("blocked-history");
      }
      const leave = !blockNavigation && window.confirm(historyPrompt);
      if (leave) {
        historyIndexRef.current = nextIndex;
        return;
      }

      const previousIndex = historyIndexRef.current;
      event.stopImmediatePropagation();
      if (previousIndex !== null && nextIndex !== null && previousIndex !== nextIndex) {
        reversingPopRef.current = true;
        window.history.go(previousIndex - nextIndex);
      } else {
        reversingPopRef.current = true;
        window.history.forward();
      }
    };

    return registerHistoryNavigationGuard(interceptHistoryTraversal);
  }, [blockNavigation, historyPrompt, when]);

  const cancelNavigation = useCallback(() => {
    pendingNavigationRef.current = null;
    setPrompt(null);
    const target = returnFocusRef.current;
    window.setTimeout(() => requestAnimationFrame(() => {
      if (target?.isConnected && target.getClientRects().length && !target.closest('[inert]')) target.focus();
    }), 0);
  }, []);

  const continueNavigation = useCallback(() => {
    if (blockNavigation) return;
    const pendingNavigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setPrompt(null);
    if (pendingNavigation) {
      if (coordinator) coordinator.runApproved(pendingNavigation); else pendingNavigation();
    }
  }, [blockNavigation, coordinator]);

  return { navigationPromptOpen, requestNavigation, cancelNavigation, continueNavigation };
}
