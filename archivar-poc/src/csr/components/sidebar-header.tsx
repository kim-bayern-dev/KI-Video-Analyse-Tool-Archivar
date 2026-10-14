import { $, t } from "defuss";
import { Logo } from "./logo.js";
import { LanguageDropdown } from "./language-dropdown.js";

/** Brand row at the top of the dashboard sidebar (screens/dashboard.tsx). */
export function SidebarHeader() {
  return (
    <div className="flex items-center gap-2 font-bold text-lg px-2 py-2 border-b-2 border-border bg-gray-50">
      <Logo />
      {t("common.app_name")}
      {/* Language chooser top right, like on the login screen. reloadOnChange
          because the dashboard renders one-shot t() strings (no <T>). */}
      <div className="ml-auto font-normal">
        <LanguageDropdown reloadOnChange buttonClassName="uk-btn-sm" />
      </div>
    </div>
  );
}
