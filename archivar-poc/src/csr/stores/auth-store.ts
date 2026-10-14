import { createStore } from "defuss";
import type { User } from "../../models/user.js";

/**
 * Client-side auth snapshot. `isLoggedIn` is derivable from `user !== null`
 * but kept as an explicit flag because the route guards in router.tsx read it.
 */
export interface AuthState {
  user: User | null;
  isLoggedIn: boolean;
}

/**
 * Single source of truth for client auth. Persisted to sessionStorage
 * (per-tab): a reload in the same tab restores the session, a new tab
 * starts logged out.
 */
export const authStore = createStore<AuthState>({
  user: null,
  isLoggedIn: false,
});

// REFACTOR(magic): storage key "archivar_auth" is repeated at every
// restore/persist call site in this file (3x) — hoist a const
// AUTH_STORAGE_KEY.

// Restore session from sessionStorage on load
authStore.restore("archivar_auth", "session");

// Mirror the user into window.$APP_PROPS — the SSR → CSR handoff object
// injected by src/pages/[...all].astro — so code outside the defuss tree
// can read the current user without importing this store.
// REFACTOR(dry): this ensure-$APP_PROPS-then-assign block is repeated by the
// restored-session init right below — extract a syncAppProps(user) helper.
authStore.subscribe((state) => {
  if (!window.$APP_PROPS) {
    window.$APP_PROPS = { user: null };
  }
  window.$APP_PROPS.user = state.user;
});

// Initialize window.$APP_PROPS from a restored session (the subscribe above
// only fires on state changes after this module loads)
if (authStore.value.isLoggedIn && authStore.value.user) {
  if (!window.$APP_PROPS) {
    window.$APP_PROPS = { user: null };
  }
  window.$APP_PROPS.user = authStore.value.user;
}

/**
 * Mark the session as logged in and persist it (sessionStorage).
 * Called by the login screen after RPC AuthApi.login succeeds.
 */
export function loginUser(user: User) {
  authStore.set({ user, isLoggedIn: true });
  authStore.persist("archivar_auth", "session");
}

/**
 * Clear the session locally. Deliberately synchronous and server-independent:
 * the logout screen calls this before notifying the server so the UI is
 * logged out even when the RPC fails.
 */
export function logoutUser() {
  authStore.set({ user: null, isLoggedIn: false });
  authStore.persist("archivar_auth", "session");
  window.$APP_PROPS = { user: null };
}
