// Local visual preview only: stands in for ./auth so the console renders signed in.
export type AppState = {
  section?: string;
  focusOp?: string;
  returnTo?: string;
};
export const loadConfig = async () => ({});
export const initAuth = async (_cfg: unknown, _o: unknown) => ({
  authenticated: new URLSearchParams(location.search).get("scene") !== "out",
  appState: undefined as AppState | undefined,
  error: undefined as string | undefined,
});
export const login = async (_s?: AppState) => {};
export const STEP_UP_INCOMPLETE = "step_up_incomplete";
