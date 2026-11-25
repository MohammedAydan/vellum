/**
 * Browser helpers for Google / GitHub sign-in (popup and redirect).
 *
 * The Vellum API is the OAuth client. The browser only starts the flow with a
 * PKCE challenge and later trades a one-time code plus its verifier for a
 * session, so a stolen code is useless on its own.
 *
 * No Node imports: this file must stay safe for edge runtimes and bundlers.
 */

export interface OAuthPopupOptions {
  /**
   * Page the provider flow returns to. Must be listed in the project's allowed
   * redirect URIs. Defaults to the current page without query or hash.
   */
  redirectUri?: string;
  /** Required by `linkWithPopup` for accounts that have a password. */
  currentPassword?: string;
  /** Give up after this many milliseconds. Default 5 minutes. */
  timeoutMs?: number;
  /** Popup window features. Defaults to a centered 480x640 window. */
  popupFeatures?: string;
  /**
   * Linking a provider asks the person to type a short code into the provider page. This is called with that code
   * so you can show it in your UI; return a function to hide it again (called when the flow ends). When omitted,
   * a small built-in box is shown in the corner of the page.
   */
  onConfirmationCode?: (code: string) => void | (() => void);
}

export interface OAuthRedirectOptions {
  redirectUri?: string;
}

export interface OAuthCallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export const OAUTH_CHANNEL = "vellum-oauth";
export const OAUTH_POPUP_NAME = "vellum-oauth-popup";
const PENDING_KEY = "vellum:oauth:pending";

interface PendingFlow {
  provider: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * The code the person types into the browser page to approve a provider link. Derived from the PKCE challenge the
 * server stored: sha256("vellum-confirm:" + challenge), first six bytes masked to 5 bits.
 */
export async function confirmationCode(challenge: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`vellum-confirm:${challenge}`))
  );
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[(digest[i] as number) & 31];
  return out;
}

/** Built-in code display used when the app passes no onConfirmationCode. Returns the remover. */
export function showDefaultConfirmationCode(code: string): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return () => undefined;
  const box = doc.createElement("div");
  box.setAttribute("role", "status");
  box.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111;color:#fff;padding:14px 18px;border-radius:10px;font:14px system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.35)";
  const label = doc.createElement("div");
  label.textContent = "Type this code into the sign-in window:";
  const value = doc.createElement("div");
  value.textContent = code;
  value.style.cssText = "font:700 26px monospace;letter-spacing:.25em;margin-top:6px";
  box.append(label, value);
  doc.body.append(box);
  return () => box.remove();
}

export function defaultRedirectUri(): string {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc) throw new Error("redirectUri is required outside a browser");
  return `${loc.origin}${loc.pathname}`;
}

export function parseCallbackParams(href: string): OAuthCallbackParams | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const code = url.searchParams.get("vellum_code");
  const error = url.searchParams.get("error");
  if (!code && !error) return null;
  return {
    code,
    state: url.searchParams.get("state"),
    error,
    errorDescription: url.searchParams.get("error_description"),
  };
}

export interface PreparedFlow {
  startUrl: string;
  state: string;
  verifier: string;
  redirectUri: string;
  /** The PKCE challenge sent to the server (the confirmation code is derived from it). */
  challenge: string;
}

/** Same shape as the auth client's request function (adds the API key header, never a query parameter). */
export type StartRequest = <R = unknown>(
  method: string,
  relativePath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  includeAuth?: boolean
) => Promise<R>;

/**
 * Asks the API to begin a sign-in. The API key travels in a header of a POST, so it is
 * never part of a URL. The response is the provider's authorize URL.
 */
export async function prepareFlow(
  request: StartRequest,
  provider: string,
  redirectUri: string | undefined,
  link = false,
  currentPassword?: string
): Promise<PreparedFlow> {
  const verifier = randomToken(48);
  const state = randomToken(16);
  const target = redirectUri ?? defaultRedirectUri();
  const challenge = await pkceChallenge(verifier);
  const res = await request<{ authorizeUrl?: unknown }>(
    "POST",
    `/auth/oauth/${encodeURIComponent(provider)}/start`,
    { redirectUri: target, codeChallenge: challenge, state, ...(link ? { link: true, ...(currentPassword !== undefined ? { currentPassword } : {}) } : {}) },
    {},
    link // linking needs the signed-in user's token; a plain sign-in sends none
  );
  if (typeof res?.authorizeUrl !== "string" || !res.authorizeUrl) {
    throw new Error("The server did not return a sign-in URL");
  }
  return { startUrl: res.authorizeUrl, state, verifier, redirectUri: target, challenge };
}

/**
 * Call this on your redirect page when you run into a browser that cuts the
 * popup/opener link (strict COOP). It forwards the result to the opener and
 * closes the popup. Safe to call on any page: it does nothing unless the URL
 * carries a Vellum sign-in result.
 */
export function completeOAuthPopup(href: string = (globalThis as { location?: Location }).location?.href ?? ""): boolean {
  const params = parseCallbackParams(href);
  if (!params) return false;
  const g = globalThis as {
    BroadcastChannel?: typeof BroadcastChannel;
    opener?: { postMessage(message: unknown, target: string): void } | null;
    location?: Location;
    close?: () => void;
  };
  if (typeof g.BroadcastChannel === "function") {
    const channel = new g.BroadcastChannel(OAUTH_CHANNEL);
    channel.postMessage({ type: "vellum-oauth-result", ...params });
    channel.close();
  }
  try {
    g.opener?.postMessage({ type: "vellum-oauth-result", ...params }, g.location?.origin ?? "*");
  } catch {
    // opener may be gone
  }
  g.close?.();
  return true;
}

/** Open a blank popup synchronously (inside the click handler); it is pointed at the provider once the flow is ready. */
export function openPopup(options: OAuthPopupOptions): Window {
  const g = globalThis as {
    open?: (url: string, name: string, features: string) => Window | null;
    screenX?: number; screenY?: number; outerWidth?: number; outerHeight?: number;
  };
  if (typeof g.open !== "function") throw new Error("signInWithPopup is only available in a browser");
  const width = 480;
  const height = 640;
  const left = Math.max(0, (g.screenX ?? 0) + ((g.outerWidth ?? width) - width) / 2);
  const top = Math.max(0, (g.screenY ?? 0) + ((g.outerHeight ?? height) - height) / 2);
  const features = options.popupFeatures ?? `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
  const popup = g.open("about:blank", OAUTH_POPUP_NAME, features);
  if (!popup) {
    throw new Error("The sign-in popup was blocked. Call signInWithPopup from a click handler, or use signInWithRedirect.");
  }
  return popup;
}

/** Wait for the result of a sign-in popup that has already been pointed at the provider. */
export function runPopup(popup: Window, flow: PreparedFlow, options: OAuthPopupOptions): Promise<OAuthCallbackParams> {
  const g = globalThis as {
    open?: (url: string, name: string, features: string) => Window | null;
    screenX?: number; screenY?: number; outerWidth?: number; outerHeight?: number;
    BroadcastChannel?: typeof BroadcastChannel;
    addEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
    removeEventListener?: (type: string, listener: (event: MessageEvent) => void) => void;
    location?: Location;
  };
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  return new Promise<OAuthCallbackParams>((resolve, reject) => {
    let done = false;
    const handles: { poll?: ReturnType<typeof setInterval>; timer?: ReturnType<typeof setTimeout> } = {};
    let channel: BroadcastChannel | undefined;
    const onMessage = (event: MessageEvent): void => {
      if (g.location && event.origin !== g.location.origin) return;
      handle(event.data);
    };
    const cleanup = (): void => {
      done = true;
      if (handles.poll) clearInterval(handles.poll);
      if (handles.timer) clearTimeout(handles.timer);
      channel?.close();
      g.removeEventListener?.("message", onMessage);
      try { popup.close(); } catch { /* already closed */ }
    };
    const handle = (data: unknown): void => {
      if (done || !data || typeof data !== "object") return;
      const d = data as Partial<OAuthCallbackParams> & { type?: string };
      if (d.type !== "vellum-oauth-result") return;
      if (d.state !== flow.state) return; // someone else's flow
      cleanup();
      resolve({ code: d.code ?? null, state: d.state ?? null, error: d.error ?? null, errorDescription: d.errorDescription ?? null });
    };
    if (typeof g.BroadcastChannel === "function") {
      channel = new g.BroadcastChannel(OAUTH_CHANNEL);
      channel.onmessage = (event) => handle(event.data);
    }
    g.addEventListener?.("message", onMessage);
    // Zero-config path: once the popup is back on our origin its URL is readable.
    handles.poll = setInterval(() => {
      if (done) return;
      let href = "";
      try {
        href = popup.location.href;
      } catch {
        href = ""; // still on the provider's origin
      }
      const params = href ? parseCallbackParams(href) : null;
      if (params && params.state === flow.state) {
        cleanup();
        resolve(params);
        return;
      }
      // A provider that sets Cross-Origin-Opener-Policy (Google does) cuts our link to the popup and
      // makes it look closed while the user is still signing in. The result then arrives through the
      // BroadcastChannel from the return page, so a closed popup is not treated as a cancel.
    }, 250);
    handles.timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new Error("Sign-in timed out"));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------- redirect mode

export function savePending(flow: PendingFlow): void {
  (globalThis as { sessionStorage?: Storage }).sessionStorage?.setItem(PENDING_KEY, JSON.stringify(flow));
}

export function takePending(): PendingFlow | null {
  const store = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  const raw = store?.getItem(PENDING_KEY);
  if (!raw) return null;
  store?.removeItem(PENDING_KEY);
  try {
    return JSON.parse(raw) as PendingFlow;
  } catch {
    return null;
  }
}

export function hasPending(): boolean {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage?.getItem(PENDING_KEY) != null;
}

/** Remove the sign-in result from the address bar so a refresh does not replay it. */
export function cleanUrl(): void {
  const g = globalThis as { location?: Location; history?: History };
  if (!g.location || !g.history) return;
  const url = new URL(g.location.href);
  for (const key of ["vellum_code", "state", "error", "error_description"]) url.searchParams.delete(key);
  g.history.replaceState(g.history.state, "", url.pathname + url.search + url.hash);
}
