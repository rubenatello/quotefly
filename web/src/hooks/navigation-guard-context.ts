import { createContext, useCallback, useContext } from "react";
import { useNavigate, type NavigateOptions, type To } from "react-router-dom";

export type NavigationAction = () => void;
export type NavigationGuard = (action: NavigationAction, returnFocus?: HTMLElement | null) => void;
export const NavigationGuardContext = createContext<{
  register: (guard: NavigationGuard) => () => void;
  request: NavigationGuard;
  runApproved: (action: NavigationAction) => void;
  isActive: () => boolean;
  withReturnFocus: (target: HTMLElement | null, action: NavigationAction) => void;
} | null>(null);
export const NavigationGuardPendingContext = createContext(false);

/** Shell actions join the active page's existing confirmation dialog. */
export function useGuardedNavigate() {
  const navigate = useNavigate();
  const coordinator = useContext(NavigationGuardContext);
  return useCallback((to: To, options?: NavigateOptions) => {
    const action = () => { void navigate(to, options); };
    if (coordinator) coordinator.request(action); else action();
  }, [coordinator, navigate]);
}
