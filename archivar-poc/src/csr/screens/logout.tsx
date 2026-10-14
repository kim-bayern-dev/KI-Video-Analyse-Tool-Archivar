import { createRef, $, Router, T as DefussT, t } from "defuss";
import type { FC, TransProps } from "defuss";
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../rpc.js";
import { logoutUser } from "../stores/auth-store.js";

// defuss's `T` returns VNodeChild, which is not assignable to JSX.Element;
// narrow the type only — the runtime value is unchanged.
const T = DefussT as unknown as FC<TransProps<string>>;

const REDIRECT_DELAY_MS = 1500;

/**
 * Public logout screen.
 *
 * Purpose: clears the local auth session and notifies the server, then
 * redirects to the login page. It must be reachable without being logged in
 * so that a stale/expired session can still be cleared cleanly.
 */
export function LogoutScreen() {
  const statusRef = createRef<HTMLDivElement>();

  const performLogout = async () => {
    // Always clear the client-side session first so the UI is logged out
    // even if the server call fails (e.g. network errors).
    logoutUser();

    try {
      const rpc = await getRpcClient<RpcApi>();
      const authApi = new rpc.AuthApi();
      await authApi.logout();
    } catch (err) {
      // Non-fatal: the client session is already cleared.
      console.error("Server logout failed:", err);
    }

    $(statusRef).update(
      <p class="text-muted-foreground">
        <T key="logout.success_message" />
      </p>,
    );

    // Give the user a moment to read the success message before navigating.
    window.setTimeout(() => {
      Router.navigate("/");
    }, REDIRECT_DELAY_MS);
  };

  return (
    <div class="w-full max-w-sm text-center">
      <h1 class="uk-h4">
        <T key="logout.heading" />
      </h1>
      <div ref={statusRef} class="mt-4">
        <p class="text-muted-foreground">
          <T key="logout.in_progress" />
        </p>
      </div>
      <div
        // Triggers the logout as soon as the element is mounted in the DOM
        onMount={performLogout}
      />
    </div>
  );
}
