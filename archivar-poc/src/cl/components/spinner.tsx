import type { Props } from "defuss";

export interface SpinnerProps extends Props {
  className?: string;
  /** Edge length in px. UIkit's data-uk-spinner was 30px at ratio 1. */
  size?: number;
}

/**
 * Loading indicator: a neutral ring rotating 360° indefinitely.
 * Pure CSS (.app-spinner in base.css), replacing the generic UIkit
 * `data-uk-spinner` icon.
 */
export const Spinner = ({
  className = "",
  size = 30,
}: SpinnerProps) => (
  <span
    style={{ width: `${size}px`, height: `${size}px` }}
    role="status"
    aria-label="Loading"
    className={["app-spinner", className].filter(Boolean).join(" ")}
  />
);
