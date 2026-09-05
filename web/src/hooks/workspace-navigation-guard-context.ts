import { createContext, useContext } from "react";

export type WorkspaceNavigationAction = () => void;
export type WorkspaceNavigationCancelAction = () => void;
export type WorkspaceNavigationGuardId = symbol;
export type WorkspaceNavigationGuardRequest = (
  action: WorkspaceNavigationAction,
  onCancel?: WorkspaceNavigationCancelAction,
) => void;

export type WorkspaceNavigationGuardContextValue = {
  registerGuard: (id: WorkspaceNavigationGuardId, request: WorkspaceNavigationGuardRequest) => () => void;
  requestNavigation: (action: WorkspaceNavigationAction) => void;
};

export const WorkspaceNavigationGuardContext = createContext<WorkspaceNavigationGuardContextValue | null>(null);

export function useWorkspaceNavigationGuardCoordinator() {
  const context = useContext(WorkspaceNavigationGuardContext);
  if (!context) {
    throw new Error("useWorkspaceNavigationGuardCoordinator must be used within WorkspaceNavigationGuardProvider");
  }
  return context;
}

export function useOptionalWorkspaceNavigationGuardCoordinator() {
  return useContext(WorkspaceNavigationGuardContext);
}
