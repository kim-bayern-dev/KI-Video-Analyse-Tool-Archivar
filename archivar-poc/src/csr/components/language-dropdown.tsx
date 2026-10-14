// LanguageDropdown.tsx
import { $, changeLanguage, createRef, getLanguage, t, type Props } from "defuss";

export interface LanguageDropdownProps extends Props {
  className?: string;
  /** Extra classes for the toggle button (e.g. "uk-btn-sm" in the sidebar). */
  buttonClassName?: string;
  /** UIkit drop position: "bottom-right" (top bars) or "top-left" (sidebar bottom). */
  pos?: string;
  /**
   * Reload the page after switching. Needed on screens built from one-shot
   * t() calls (the dashboard) — unlike <T>-based screens (login/logout),
   * their strings do not react to changeLanguage.
   */
  reloadOnChange?: boolean;
}

/**
 * de/en language switcher. The choice is persisted to sessionStorage
 * ("archivar-lang") and re-applied by the router bootstrap on next load
 * (src/csr/router.tsx). Rendered by PreAuthLayout (top right, like the login
 * screen) and by the dashboard SidebarHeader (top right, reloadOnChange).
 */
export function LanguageDropdown({
  className = "",
  buttonClassName = "",
  pos = "bottom-right",
  reloadOnChange = false,
}: LanguageDropdownProps) {
  const lang = getLanguage(); // "de" | "en"
  const rootEl = createRef<HTMLDivElement>();
  const langLabelEl = createRef<HTMLSpanElement>();

  const setLang = (l: "de" | "en") => (e: MouseEvent) => {
    e.preventDefault();
    console.log("Switching language to", l);
    if (l !== getLanguage()) {
      changeLanguage(l);
      // REFACTOR(magic): "archivar-lang" is duplicated at the router
      // bootstrap (src/csr/router.tsx) — hoist a shared LANG_STORAGE_KEY.
      sessionStorage.setItem("archivar-lang", l);
      if (reloadOnChange) {
        window.location.reload();
        return;
      }
    }
    // mark li as active (scoped to this dropdown)
    rootEl.current?.querySelectorAll("li").forEach((li) => li.classList.remove("uk-active"));
    (e.currentTarget as HTMLElement).parentElement?.classList.add("uk-active");
    // update button label
    $(langLabelEl).text(l.toUpperCase());
  };

  return (
    <div ref={rootEl} class={`uk-inline ${className}`}>
      <button class={`uk-btn uk-btn-default ${buttonClassName}`} type="button" aria-haspopup="true" aria-expanded="false">
        <span ref={langLabelEl} class="uk-margin-small-left">{lang?.toUpperCase?.() ?? "DE"}</span>
      </button>

      {/* FrankenUI/UK dropdown - aim-aware, click mode */}
      <div class="uk-drop uk-dropdown min-w-52" data-uk-dropdown={`mode: click; pos: ${pos}`}>
        <ul class="uk-nav uk-dropdown-nav">
          <li class={lang === "de" ? "uk-active" : ""}>
            <a href="#" onClick={setLang("de")}>{t("language.german")}</a>
          </li>
          <li class={lang === "en" ? "uk-active" : ""}>
            <a href="#" onClick={setLang("en")}>{t("language.english")}</a>
          </li>
        </ul>
      </div>
    </div>
  );
}
