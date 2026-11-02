// Real Auth0 Universal Login via @auth0/auth0-spa-js. No persona switching.
import { Auth0Client } from "@auth0/auth0-spa-js";

export type AuthConfig = {
  domain: string;
  clientId: string;
  audience: string;
  scope?: string;
  organization?: string;
  /** Universal Login connection to go straight to (the demo uses passwordless email OTP). */
  connection?: string;
  /** Sender-constrain access tokens with DPoP. Defaults to true: routine tiers require it. */
  dpop?: boolean;
};

/** returnTo: a page other than the console to go back to after sign-in ("/admin" only). */
export type AppState = {
  section?: string;
  focusOp?: string;
  returnTo?: string;
};

// Sign-in asks for no decision scope, so the approval Action runs no MFA at
// sign-in: email OTP alone. Each decision steps up on its own (stepUp below).
const DEFAULT_SCOPE = "openid profile email approvals:read";
const DECIDE_SCOPE = "approvals:decide";
const withDecide = (scope: string) =>
  scope.split(" ").includes(DECIDE_SCOPE) ? scope : `${scope} ${DECIDE_SCOPE}`;
const MFA_ACR = "http://schemas.openid.net/pape/policies/2007/06/multi-factor";

let cfg: AuthConfig;
let client: Auth0Client;

/** Reads the auth settings, retrying a cold start: the first request after the Worker or
 *  database has been idle can fail once, and a single miss must not show an error. */
export async function loadConfig(
  opts: { delays?: number[] } = {},
): Promise<AuthConfig> {
  const delays = opts.delays ?? [300, 900, 2000];
  let last = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    try {
      const r = await fetch("/sandbox/info", {
        headers: { accept: "application/json" },
      });
      if (!r.ok) {
        last = `status ${r.status}`;
        // A client error will not fix itself; anything else is retried.
        if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
        continue;
      }
      const cfg = parseConfig((await r.json()) as Record<string, unknown>);
      if (cfg) return cfg;
      last = "no Auth0 settings in the response";
      break;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(
    `Could not load the sign-in settings from /sandbox/info (${last}). Reload the page in a moment.`,
  );
}

export function parseConfig(
  raw: Record<string, unknown>,
): AuthConfig | undefined {
  const j = (
    raw.auth && typeof raw.auth === "object" ? raw.auth : raw
  ) as Record<string, unknown>;
  const domain = String(j.domain ?? j.auth0Domain ?? "");
  const clientId = String(
    j.clientId ?? j.spaClientId ?? j.reviewerClientId ?? "",
  );
  const audience = String(j.audience ?? j.authorityAudience ?? "");
  if (!domain || !clientId || !audience) return undefined;
  return {
    domain,
    clientId,
    audience,
    scope: typeof j.scope === "string" ? j.scope : undefined,
    organization:
      typeof j.organization === "string" ? j.organization : undefined,
    connection: typeof j.connection === "string" ? j.connection : undefined,
    dpop: j.dpop === false ? false : true,
  };
}

// Auth0 only allows the site root as a callback, so other pages (/admin) pass "/".
let redirectPath: string | undefined;
const redirectUri = () =>
  `${location.origin}${redirectPath ?? location.pathname}`;

export async function initAuth(
  c: AuthConfig,
  opts: { redirectPath?: string } = {},
): Promise<{
  authenticated: boolean;
  appState?: AppState;
  /** Auth0 came back with an error (a failed step-up); the cached sign-in may still stand. */
  error?: string;
}> {
  cfg = c;
  redirectPath = opts.redirectPath;
  // Not createAuth0Client: its load-time checkSession runs a silent iframe login, and when
  // that returns login_required (third-party cookies blocked, or a step-up in progress) the SDK
  // logs out locally and deletes the DPoP key. The step-up challenge is bound to that key, so
  // the redirect callback must complete with the key that requested it. Silent login runs
  // only on a plain page load.
  client = new Auth0Client({
    domain: c.domain,
    clientId: c.clientId,
    cacheLocation: "localstorage",
    useDpop: c.dpop !== false,
    authorizationParams: {
      audience: c.audience,
      redirect_uri: redirectUri(),
      scope: c.scope ?? DEFAULT_SCOPE,
      ...(c.organization ? { organization: c.organization } : {}),
      ...(c.connection ? { connection: c.connection } : {}),
    },
  });
  let appState: AppState | undefined;
  const q = new URLSearchParams(location.search);
  if (q.has("code") && q.has("state")) {
    const res = await client.handleRedirectCallback<AppState>();
    appState = res.appState;
    history.replaceState({}, "", redirectUri());
  } else if (q.has("error")) {
    const msg =
      q.get("error_description") ?? q.get("error") ?? "Sign-in failed";
    history.replaceState({}, "", redirectUri());
    // A failed step-up must not cost the reviewer their sign-in: keep the cached
    // session and report the error, so actions that need no step-up still work.
    const authenticated = await client.isAuthenticated();
    if (!authenticated) throw new Error(msg);
    return { authenticated, error: msg };
  } else if (!(await client.isAuthenticated())) {
    // A cached session needs no hidden-iframe round trip to Auth0 on every page load; an
    // expired access token is renewed on first use by getTokenSilently.
    await client.checkSession().catch(() => undefined);
  }
  return { authenticated: await client.isAuthenticated(), appState };
}

export const login = (appState: AppState = {}) =>
  client.loginWithRedirect({ appState });

export const logout = () =>
  client.logout({ logoutParams: { returnTo: redirectUri() } });

export const user = () => client.getUser();

/** The raw Auth0 ID token; the Worker reads the verified email from it. */
export const idToken = async () =>
  (await client.getIdTokenClaims().catch(() => undefined))?.__raw;

export type StepUp = { acr_values: string; max_age: number };
/** `max_age: null` sends none. */
type StepUpRequest = { acr_values?: string; max_age?: number | null };

/** Authorize parameters for a step-up. `max_age: null` keeps the Auth0 session's first
 *  factor: the Action still forces a fresh second factor, and the service checks that
 *  factor's own timestamp, so re-entering the email code would only add a step. */
export function stepUpParams(
  p: StepUpRequest,
  scope: string,
  extra: Record<string, string> = {},
): Record<string, string | number> {
  const maxAge = p.max_age === undefined ? 0 : p.max_age;
  return {
    acr_values: p.acr_values ?? MFA_ACR,
    ...(maxAge === null ? {} : { max_age: maxAge }),
    scope: withDecide(scope),
    ...extra,
  };
}

/** Real re-authentication: Auth0 Universal Login runs MFA again with these parameters. */
export async function stepUp(
  p: StepUpRequest,
  appState: AppState = {},
  extra: Record<string, string> = {},
) {
  // If Auth0's session has ended, the sign-in screen opens with the reviewer's email
  // filled in, so the step-up does not look like a new account.
  const email = (await client.getUser().catch(() => undefined))?.email;
  return client.loginWithRedirect({
    appState,
    authorizationParams: {
      ...(email ? { login_hint: email } : {}),
      ...stepUpParams(p, cfg.scope ?? DEFAULT_SCOPE, extra),
      audience: cfg.audience,
      redirect_uri: redirectUri(),
      ...(cfg.organization ? { organization: cfg.organization } : {}),
    } as never,
  });
}

/** No step-up token in the cache: the reviewer came back without finishing Auth0. */
export const STEP_UP_INCOMPLETE = "step_up_incomplete";

/** The token request a call should make. The step-up token is cached under the decide
 *  scope; a plain request for the sign-in scope matches the sign-in token exactly, so a
 *  replay after the step-up would send a token with no second factor (mfa_required). */
export function tokenRequest(
  stepUpToken: boolean,
  scope: string,
  audience: string,
) {
  return stepUpToken
    ? {
        authorizationParams: { audience, scope: withDecide(scope) },
        // Only the token the step-up just stored: never a silent re-login for it.
        cacheMode: "cache-only" as const,
      }
    : { authorizationParams: { audience } };
}

/** Parse an RFC 9470 WWW-Authenticate challenge. */
export function parseChallenge(
  header: string | null,
): Partial<StepUp> | undefined {
  if (!header || !/insufficient_user_authentication/.test(header))
    return undefined;
  const acr = header.match(/acr_values="([^"]+)"/)?.[1];
  const age = header.match(/max_age="?(\d+)"?/)?.[1];
  return {
    ...(acr ? { acr_values: acr } : {}),
    ...(age ? { max_age: Number(age) } : {}),
  };
}

export async function authedFetch(
  path: string,
  init: RequestInit = {},
  opts: { stepUpToken?: boolean } = {},
): Promise<Response> {
  const req = tokenRequest(
    Boolean(opts.stepUpToken),
    cfg.scope ?? DEFAULT_SCOPE,
    cfg.audience,
  );
  if (cfg.dpop !== false) {
    // dpopNonceId is what makes fetchWithAuth attach the DPoP proof; without it the SDK
    // sends "Authorization: DPoP <token>" with no proof and the service rejects it.
    const f = client.createFetcher({
      dpopNonceId: "task-authority",
      ...(opts.stepUpToken
        ? {
            getAccessToken: async () => {
              const t = await client.getTokenSilently(req);
              if (!t) throw new Error(STEP_UP_INCOMPLETE);
              return t;
            },
          }
        : {}),
    });
    return f.fetchWithAuth(path, init, {
      audience: cfg.audience,
    } as never);
  }
  const token = await client.getTokenSilently(req);
  if (!token) throw new Error(STEP_UP_INCOMPLETE);
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}
