// Vendored from the playkit SDK — do not edit here.
// Source: playkit/sdk/src/index.ts
// Re-sync with: npm run vendor  (in playkit/sdk)
/**
 * playkit browser SDK
 *
 * One client for auth, cloud saves, and leaderboards. Framework-agnostic on
 * purpose: it is plain TypeScript with no dependencies, so it works the same in
 * a React game and in a single-file HTML game.
 *
 *   const pk = createPlaykit({ baseUrl: 'http://localhost:4000', gameId: 'my-game' });
 *   await pk.restore();                 // resume a session from a previous visit
 *   await pk.login(email, password);
 *   await pk.saveProgress({ day: 3 });
 */

export interface PlaykitUser {
  id: string;
  email: string;
  displayName: string;
}

export interface PlaykitOptions {
  /** Where the playkit server lives, e.g. https://api.example.com */
  baseUrl: string;
  /** Which game this client is for — scopes saves and scores. */
  gameId: string;
  /** Called whenever the signed-in user changes (including sign-out). */
  onAuthChange?: (user: PlaykitUser | null) => void;
}

export interface SaveEnvelope<T = unknown> {
  data: T;
  version: number;
  updatedAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
}

// Fields are declared and assigned explicitly rather than using constructor
// parameter properties: that shorthand emits real code, so it is rejected by
// projects compiled with `erasableSyntaxOnly` (and by Node's native type
// stripping). Keeping the SDK free of non-erasable syntax lets any game drop it
// in regardless of its TypeScript settings.

/** Thrown for any non-2xx response, carrying the server's message. */
export class PlaykitError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'PlaykitError';
    this.status = status;
    this.code = code;
  }
}

/** A save was rejected because the server has newer data. */
export class SaveConflictError extends PlaykitError {
  readonly currentVersion: number;

  constructor(message: string, currentVersion: number) {
    super(message, 409, 'version_conflict');
    this.name = 'SaveConflictError';
    this.currentVersion = currentVersion;
  }
}

export function createPlaykit(options: PlaykitOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const { gameId } = options;

  // A purely local note that this browser has signed in before. Without it,
  // `restore()` would call the server on every single page load — including for
  // players who have never made an account and never will, which is most of
  // them. It carries no authority: forging it only buys you a 401, because the
  // httpOnly refresh cookie is what actually proves anything.
  //
  // The trade-off: clearing site data but keeping cookies makes a real session
  // look absent. That combination is rare, and signing in again fixes it.
  const hintKey = `playkit_seen:${baseUrl}`;
  function setSessionHint(on: boolean) {
    try {
      if (on) localStorage.setItem(hintKey, '1');
      else localStorage.removeItem(hintKey);
    } catch {
      // Private mode or blocked storage: fall back to always asking the server.
    }
  }
  function hasSessionHint(): boolean {
    try {
      return localStorage.getItem(hintKey) === '1';
    } catch {
      return true;
    }
  }

  // The access token is kept in memory only. It is short-lived, and keeping it
  // out of localStorage means an XSS bug cannot walk off with a durable
  // credential — the long-lived refresh token is an httpOnly cookie the page's
  // JavaScript can never read.
  let accessToken: string | null = null;
  let currentUser: PlaykitUser | null = null;
  let refreshInFlight: Promise<boolean> | null = null;

  function setUser(user: PlaykitUser | null) {
    currentUser = user;
    options.onAuthChange?.(user);
  }

  async function parse(res: Response): Promise<any> {
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (res.ok) return body;

    if (res.status === 409 && body.error === 'version_conflict') {
      throw new SaveConflictError(body.message ?? 'Save conflict', body.currentVersion ?? 0);
    }
    throw new PlaykitError(
      body.message ?? `Request failed (${res.status})`,
      res.status,
      body.error ?? 'unknown',
    );
  }

  function request(path: string, init: RequestInit = {}, withAuth = false): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (withAuth && accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      // Required so the refresh cookie travels cross-origin.
      credentials: 'include',
    });
  }

  /** Exchanges the refresh cookie for a new access token. Deduplicated. */
  function refresh(): Promise<boolean> {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const res = await request('/auth/refresh', { method: 'POST' });
          if (!res.ok) {
            accessToken = null;
            setUser(null);
            // The cookie is gone or spent; stop asking on every future load.
            setSessionHint(false);
            return false;
          }
          const body = await res.json();
          accessToken = body.accessToken;
          setUser(body.user);
          setSessionHint(true);
          return true;
        } catch {
          return false;
        } finally {
          refreshInFlight = null;
        }
      })();
    }
    return refreshInFlight;
  }

  /**
   * Authenticated request that transparently refreshes once on a 401, so a
   * game never has to think about token expiry mid-session.
   */
  async function authed(path: string, init: RequestInit = {}): Promise<any> {
    if (!accessToken) {
      const ok = await refresh();
      if (!ok) throw new PlaykitError('Sign in to continue.', 401, 'unauthorized');
    }
    let res = await request(path, init, true);
    if (res.status === 401) {
      const ok = await refresh();
      if (!ok) throw new PlaykitError('Your session expired. Sign in again.', 401, 'unauthorized');
      res = await request(path, init, true);
    }
    return parse(res);
  }

  async function adoptSession(res: Response) {
    const body = await parse(res);
    accessToken = body.accessToken;
    setUser(body.user);
    setSessionHint(true);
    return body.user as PlaykitUser;
  }

  return {
    get user(): PlaykitUser | null {
      return currentUser;
    },
    get isSignedIn(): boolean {
      return currentUser !== null;
    },

    /**
     * Call once on load. Silently resumes a session from a previous visit
     * (using the refresh cookie) and returns the user, or null if not signed in.
     *
     * Costs nothing for a player who has never signed in on this browser: it
     * returns without touching the network at all.
     */
    async restore(): Promise<PlaykitUser | null> {
      if (!hasSessionHint()) return null;
      await refresh();
      return currentUser;
    },

    async register(email: string, password: string, displayName?: string): Promise<PlaykitUser> {
      return adoptSession(
        await request('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password, displayName }),
        }),
      );
    },

    async login(email: string, password: string): Promise<PlaykitUser> {
      return adoptSession(
        await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
      );
    },

    /** Completes Google sign-in with the ID token from Google Identity Services. */
    async loginWithGoogle(idToken: string): Promise<PlaykitUser> {
      return adoptSession(
        await request('/auth/google', { method: 'POST', body: JSON.stringify({ idToken }) }),
      );
    },

    /**
     * Asks for a reset link. Resolves the same way whether or not the address
     * has an account — the server deliberately doesn't say, so the UI can't
     * either. Rejects only on a malformed address or rate limiting.
     */
    async requestPasswordReset(email: string): Promise<void> {
      await parse(
        await request('/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email }),
        }),
      );
    },

    async logout(): Promise<void> {
      try {
        await request('/auth/logout', { method: 'POST' });
      } finally {
        accessToken = null;
        setUser(null);
        setSessionHint(false);
      }
    },

    async setDisplayName(displayName: string): Promise<PlaykitUser> {
      const body = await authed('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ displayName }),
      });
      setUser(body.user);
      return body.user;
    },

    /** Returns null when this player has no cloud save yet. */
    async loadProgress<T = unknown>(): Promise<SaveEnvelope<T> | null> {
      const body = await authed(`/games/${gameId}/save`);
      return body.save ?? null;
    },

    /**
     * Writes the player's save. Pass `version` from the last load to get
     * conflict detection — a SaveConflictError means another device saved first.
     */
    async saveProgress(data: unknown, version?: number): Promise<{ version: number; updatedAt: string }> {
      const body = await authed(`/games/${gameId}/save`, {
        method: 'PUT',
        body: JSON.stringify({ data, version }),
      });
      return body.save;
    },

    async clearProgress(): Promise<void> {
      await authed(`/games/${gameId}/save`, { method: 'DELETE' });
    },

    async submitScore(score: number, opts: { board?: string; meta?: unknown } = {}): Promise<void> {
      await authed(`/games/${gameId}/scores`, {
        method: 'POST',
        body: JSON.stringify({ score, board: opts.board, meta: opts.meta }),
      });
    },

    /** Public — works whether or not anyone is signed in. */
    async getLeaderboard(opts: { board?: string; limit?: number } = {}): Promise<LeaderboardEntry[]> {
      const params = new URLSearchParams();
      if (opts.board) params.set('board', opts.board);
      if (opts.limit) params.set('limit', String(opts.limit));
      const query = params.toString();
      const res = await request(`/games/${gameId}/leaderboard${query ? `?${query}` : ''}`);
      const body = await parse(res);
      return body.entries;
    },

    async getMyRank(board?: string): Promise<{ rank: number | null; best: number | null }> {
      const query = board ? `?board=${encodeURIComponent(board)}` : '';
      return authed(`/games/${gameId}/my-rank${query}`);
    },
  };
}

export type Playkit = ReturnType<typeof createPlaykit>;

/* ------------------------------------------------------------------ */
/* Google sign-in                                                      */
/* ------------------------------------------------------------------ */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiPromise: Promise<void> | null = null;

/** Loads Google Identity Services once, no matter how many callers ask. */
function loadGoogleIdentity(): Promise<void> {
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      if ((window as any).google?.accounts?.id) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Google script failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google script failed to load'));
    document.head.appendChild(s);
  });

  return gsiPromise;
}

export interface GoogleButtonOptions {
  /** OAuth "Web application" client ID. Not a secret — it ships in the page. */
  clientId: string;
  /** Where to draw the button. */
  container: HTMLElement;
  /** Called with the signed-in user once playkit has verified the token. */
  onSignedIn: (user: PlaykitUser) => void;
  onError?: (err: unknown) => void;
  theme?: 'outline' | 'filled_black' | 'filled_blue';
  size?: 'small' | 'medium' | 'large';
  width?: number;
}

/**
 * Renders Google's sign-in button and completes the exchange with playkit.
 *
 * Google hands the browser an ID token, which the server verifies against
 * Google's public keys — so nothing secret lives in the page and there is no
 * redirect flow to get wrong. Resolves to false when Google can't be reached
 * (offline, blocked, no client ID), so callers can just hide the button.
 */
export async function mountGoogleButton(
  pk: Playkit,
  opts: GoogleButtonOptions,
): Promise<boolean> {
  if (!opts.clientId) return false;
  try {
    await loadGoogleIdentity();
  } catch {
    return false;
  }

  const google = (window as any).google;
  if (!google?.accounts?.id) return false;

  google.accounts.id.initialize({
    client_id: opts.clientId,
    callback: async (response: { credential?: string }) => {
      if (!response?.credential) return;
      try {
        opts.onSignedIn(await pk.loginWithGoogle(response.credential));
      } catch (err) {
        opts.onError?.(err);
      }
    },
  });

  google.accounts.id.renderButton(opts.container, {
    type: 'standard',
    theme: opts.theme ?? 'filled_black',
    size: opts.size ?? 'large',
    text: 'continue_with',
    shape: 'rectangular',
    width: opts.width ?? 220,
  });

  return true;
}
