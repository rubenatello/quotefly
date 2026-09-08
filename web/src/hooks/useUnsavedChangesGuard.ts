import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload, useNavigate } from "react-router-dom";
import { useOptionalWorkspaceNavigationGuardCoordinator } from "./workspace-navigation-guard-context";

type PendingNavigation = {
  action: () => void;
  onCancel?: () => void;
  focusOrigin: HTMLElement | null;
} | null;

interface UnsavedChangesGuardOptions {
  historyPrompt?: string;
}

export function useUnsavedChangesGuard(when: boolean, options: UnsavedChangesGuardOptions = {}) {
  const navigate = useNavigate();
  const coordinator = useOptionalWorkspaceNavigationGuardCoordinator();
  const historyPrompt = options.historyPrompt ?? "";
  const guardIdRef = useRef(Symbol("workspace-unsaved-changes-guard"));
  const pendingNavigationRef = useRef<PendingNavigation>(null);
  const [navigationPromptOpen, setNavigationPromptOpen] = useState(false);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!when) return;
        event.preventDefault();
        event.returnValue = historyPrompt;
      },
      [historyPrompt, when],
    ),
  );

  const openNavigationPrompt = useCallback(
    (action: () => void, onCancel?: () => void) => {
      if (!when) {
        action();
        return;
      }
      const activeElement = document.activeElement;
      pendingNavigationRef.current = {
        action,
        onCancel,
        focusOrigin: activeElement instanceof HTMLElement ? activeElement : null,
      };
      setNavigationPromptOpen(true);
    },
    [when],
  );

  useEffect(() => {
    if (!when || !coordinator) return;
    return coordinator.registerGuard(guardIdRef.current, openNavigationPrompt);
  }, [coordinator, openNavigationPrompt, when]);

  useEffect(() => {
    if (when) return;
    pendingNavigationRef.current?.onCancel?.();
    pendingNavigationRef.current = null;
    setNavigationPromptOpen(false);
  }, [when]);

  const requestNavigation = useCallback(
    (action: () => void) => {
      if (coordinator) {
        coordinator.requestNavigation(action);
        return;
      }
      openNavigationPrompt(action);
    },
    [coordinator, openNavigationPrompt],
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

  const cancelNavigation = useCallback(() => {
    const pendingNavigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setNavigationPromptOpen(false);
    if (pendingNavigation?.onCancel) {
      pendingNavigation.onCancel();
      return;
    }
    const focusOrigin = pendingNavigation?.focusOrigin;
    window.requestAnimationFrame(() => {
      if (focusOrigin?.isConnected) {
        focusOrigin.focus({ preventScroll: true });
      }
    });
  }, []);

  const continueNavigation = useCallback(() => {
    const pendingNavigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setNavigationPromptOpen(false);
    pendingNavigation?.action();
  }, []);

  return { navigationPromptOpen, requestNavigation, cancelNavigation, continueNavigation };
}
