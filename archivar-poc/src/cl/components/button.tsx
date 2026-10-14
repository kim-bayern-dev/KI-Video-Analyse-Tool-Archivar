import { createRef, type Props, type Ref, type VNode } from "defuss";
import { Spinner } from "./spinner.js";

export interface ButtonProps extends Props {
  className?: string;
  ref?: Ref<HTMLButtonElement> | Ref<HTMLAnchorElement>; // allow ref to be passed (forwarded down)

  type?:
    | "default"
    | "primary"
    | "ghost"
    | "secondary"
    | "destructive"
    | "text"
    | "link";
  size?: "xs" | "sm" | "md" | "lg";
  icon?: VNode;
  iconOnly?: boolean;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  as?: "button" | "a";
  href?: string;
  onClick?: (evt?: MouseEvent) => any;

  // allow for any other prop that a button or anchor element can have
  [key: string]: any;
}

export const Button = ({
  children,
  type = "default",
  size,
  icon,
  ref = createRef<HTMLButtonElement>(),
  iconOnly = false,
  className = "",
  fullWidth = false,
  loading = false,
  disabled = false,
  as = "button",
  href,
  ...props
}: ButtonProps) => {
  const baseClass = "uk-btn";
  const typeClass = `uk-btn-${type}`;
  const sizeClass = size ? `uk-btn-${size}` : "";
  const iconClass = iconOnly ? "uk-btn-icon" : "";
  const widthClass = fullWidth ? "w-full" : "";

  const classes = [
    baseClass,
    typeClass,
    sizeClass,
    iconClass,
    widthClass,
    className,
  ].filter(Boolean);

  const content = (
    <>
      {loading && <Spinner size={16} className="align-middle" />}
      {icon}
      {!iconOnly && children}
    </>
  );

  if (as === "a" && href) {
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        class={classes}
        aria-disabled={disabled}
        {...props}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type="button"
      class={classes}
      disabled={disabled || loading}
      {...props}
    >
      {content}
    </button>
  );
};
