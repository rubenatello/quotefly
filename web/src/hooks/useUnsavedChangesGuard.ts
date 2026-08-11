import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload, useNavigate } from "react-router-dom";

type PendingNavigation = (() => void) | null;

interface UnsavedChangesGuardOptions {
  historyPrompt?: string;
}

export function useUnsavedChangesGuard(when: boolean, options: UnsavedChangesGuardOptions = {}) {
  const navigate = useNavigate();
  const historyPrompt =
    options.historyPrompt ?? "You have unsaved quote changes. Leave this page and keep the browser recovery draft?";
  const pendingNavigationRef = useRef<PendingNavigation>(null);
  const historyIndexRef = useRef<number | null>(
    typeof window !== "undefined" && typeof window.history.state?.idx === "number" ? window.history.state.idx : null,
  );
  const reversingPopRef = useRef(false);
  const [navigationPromptOpen, setNavigationPromptOpen] = useState(false);

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
    (action: () => void) => {
      if (!when) {
        action();
        return;
      }
      pendingNavigationRef.current = action;
      setNavigationPromptOpen(true);
    },
    [when],
  );

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

  useEffect(() => {
    if (!when) {
      historyIndexRef.current = typeof window.history.state?.idx === "number" ? window.history.state.idx : null;
      return;
    }

    const interceptHistoryTraversal = (event: PopStateEvent) => {
      const nextIndex = typeof window.history.state?.idx === "number" ? window.history.state.idx : null;
      if (reversingPopRef.current) {
        event.stopImmediatePropagation();
        reversingPopRef.current = false;
        historyIndexRef.current = nextIndex;
        return;
      }

      const leave = window.confirm(historyPrompt);
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

    window.addEventListener("popstate", interceptHistoryTraversal, true);
    return () => window.removeEventListener("popstate", interceptHistoryTraversal, true);
  }, [historyPrompt, when]);

  const cancelNavigation = useCallback(() => {
    pendingNavigationRef.current = null;
    setNavigationPromptOpen(false);
  }, []);

  const continueNavigation = useCallback(() => {
    const pendingNavigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setNavigationPromptOpen(false);
    pendingNavigation?.();
  }, []);

  return { navigationPromptOpen, requestNavigation, cancelNavigation, continueNavigation };
}
