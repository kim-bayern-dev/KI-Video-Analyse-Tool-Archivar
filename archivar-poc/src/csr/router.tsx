import {
  changeLanguage,
  loadLanguage,
  Redirect,
  Route,
  RouterSlot,
  type Props,
} from "defuss";
import { LoginScreen } from "./screens/login";
import { LogoutScreen } from "./screens/logout";
import { PreAuthLayout } from "./layouts/pre-auth";
import { Spinner } from "../cl/index.js";
import { authStore } from "./stores/auth-store";

import de from "../../i18n/de.json";
import en from "../../i18n/en.json";

// Language bootstrap runs at module import so translations are registered
// before the first render. The initial language mirrors what
// LanguageDropdown persists (sessionStorage key "archivar-lang").
loadLanguage("de", de);
loadLanguage("en", en);
changeLanguage(sessionStorage.getItem("archivar-lang") as "de" | "en" || "de");

/**
 * Lazy-loaded dashboard route.
 *
 * Why: the dashboard module graph eagerly fetches the RPC schema at import time
 * (via top-level `await getRpcClient()`). Loading it eagerly would crash router
 * hydration on every public route (e.g. `/logout`, `/`) when the user has an
 * expired/missing token, because the schema request fails with 403.
 *
 * Using Route's `component` prop (called lazily, only when the route matches)
 * together with a dynamic `import()` keeps the dashboard — and its schema fetch —
 * out of the bundle until the authenticated `/dashboard` route actually renders.
 */
const LazyDashboard = async () => {
  const { DashboardScreen } = await import(/* @vite-ignore */ "./screens/dashboard.js");
  return <DashboardScreen />;
};

/** Loading fallback shown while the dashboard chunk loads: the Spinner
 *  component (rotating ring), centered on screen. */
const DashboardFallback = (_props: Props) => (
  <div class="flex items-center justify-center min-h-svh">
    <Spinner size={48} />
  </div>
);

/**
 * Route table plus auth guards.
 *
 * The guards are two conditional <Redirect> declarations: defuss Redirect
 * fires whenever its path matches, so each redirect is rendered only in the
 * auth state where it applies — logged-in users hitting "/" are pushed to
 * /dashboard, logged-out users hitting "/dashboard" are pushed back to "/".
 * `isLoggedIn` requires both the flag and a user object to guard against a
 * restored session where the two disagree.
 */
export function RouterOutlet() {
  const isLoggedIn = authStore.value.isLoggedIn && !!authStore.value.user;

  // REFACTOR(kiss): leftover debug log in the render path — fires on every
  // outlet evaluation; remove it or put it behind a debug flag.
  console.log("RouterOutlet: isLoggedIn =", isLoggedIn);

  return (
    <>
      {isLoggedIn && <Redirect path="/" exact={true} to="/dashboard" />}

      <Route path="/">
        <PreAuthLayout>
          <LoginScreen />
        </PreAuthLayout>
      </Route>

      {/* Public route: clears the session and redirects to login.
          Intentionally not gated by isLoggedIn so it works without auth. */}
      <Route path="/logout">
        <PreAuthLayout>
          <LogoutScreen />
        </PreAuthLayout>
      </Route>

      <Route path="/dashboard" component={LazyDashboard}>
        <DashboardFallback />
      </Route>

      {!isLoggedIn && <Redirect path="/dashboard" exact={true} to="/" />}
    </>
  );
}

/** Mounts the defuss RouterSlot that drives RouterOutlet on navigation. */
export function Router() {
  return <RouterSlot tag="div" RouterOutlet={RouterOutlet} />;
}
