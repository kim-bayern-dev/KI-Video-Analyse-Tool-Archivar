import type { Props } from "defuss";

export interface LogoProps extends Props {
  width?: string;
}

/**
 * Brand logo used by the header/sidebar chrome. Links to /dashboard via a
 * plain anchor: defuss does not intercept anchor clicks, so this is a full
 * document navigation, not client-side routing.
 */
export function Logo({ width = "32px" }: LogoProps) {
  return (
    <a href="/dashboard">
      <img src="/images/logo.png" width={width} alt="Archivar logo" />
    </a>
  );
}
