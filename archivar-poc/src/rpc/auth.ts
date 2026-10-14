import { getArchivarConfig, resolveEnvValue } from "../lib/archivar-config.js";

/**
 * Login outcome. On success the returned user object is what the client stores
 * and presents as its identity — no server-side session is created.
 */
export interface AuthResult {
  success: boolean;
  user?: {
    uid: string;
    email: string;
    name: string;
  };
  error?: string;
}

/**
 * Credential check against the static user list in archivar.config.ts
 * (usernames/passwords may be env references, resolved via resolveEnvValue).
 * Stateless: login only verifies, logout is a client-side concern.
 */
export class AuthApi {
  public async login(email: string, password: string): Promise<AuthResult> {
    const config = getArchivarConfig();
    const matchedUser = config.auth.users.find(
      (u) => resolveEnvValue(u.username) === email && resolveEnvValue(u.password) === password,
    );

    if (!matchedUser) {
      return { success: false, error: "Invalid credentials" };
    }

    const resolvedUsername = resolveEnvValue(matchedUser.username);
    // REFACTOR(kiss): uid, email and name always carry the same string — the
    // AuthResult type pretends they are distinct fields; collapse to one.
    return {
      success: true,
      user: {
        uid: resolvedUsername,
        email: resolvedUsername,
        name: resolvedUsername,
      },
    };
  }

  /** No-op: there is no server-side session to invalidate; the client discards its stored user. */
  public async logout(): Promise<{ success: boolean }> {
    return { success: true };
  }
}
