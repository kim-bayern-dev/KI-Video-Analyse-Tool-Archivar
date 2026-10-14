import type { Props } from "defuss";
import { LanguageDropdown } from "../components/language-dropdown.js";

/**
 * Layout for public, pre-authentication screens (login at "/", logout at
 * "/logout"): form column on the left, muted cover panel on the right (lg+).
 * Hosts the LanguageDropdown because these routes render without any
 * dashboard chrome (header/sidebar).
 */
export const PreAuthLayout = ({ children }: Props) => {
  return (
    <div class="grid min-h-svh lg:grid-cols-2">
      <div class="flex flex-col gap-4 p-6 md:p-10">
        <div class="relative flex justify-center">
          {/* Centered logo, in normal flow so the row grows with its height.
              The right-side dropdown is absolutely positioned instead. */}
          {/* REFACTOR(dry): duplicates the Logo component
              (src/csr/components/logo.tsx:7) with a hardcoded width and a
              dead href="#" — reuse <Logo width="80px" /> instead. */}
          <div class="flex flex-col items-center gap-4">
            <a href="#">
              <img src="/images/logo.png" width="80px" alt="Archivar logo" />
            </a>
          </div>

          {/* Right side dropdown button */}
          <div class="absolute right-0 top-0 flex justify-end">
            {/* Theme and language dropdowns
            <button class="uk-btn uk-btn-default" type="button">
              <div class="size-4">
                <uk-icon icon="smile"></uk-icon>
              </div>
            </button>
            */}
            {/* REFACTOR(kiss): this theme-switcher dropdown is unreachable —
                its only toggle button is commented out above, so UIkit never
                opens it. Restore the button or delete the ~55 lines of inert
                markup. */}
            <div
              class="uk-drop uk-dropdown min-w-52"
              data-uk-dropdown="mode: click"
            >
              <ul class="uk-nav uk-dropdown-nav p-4 bg-light shadow-md">
                <uk-theme-switcher>
                  <select hidden class="p-2  border border-gray-300">
                    <optgroup data-key="theme" label="Theme" class="p-2">
                      <option data-hex="#52525b" value="uk-theme-zinc" selected>
                        Zinc
                      </option>
                      <option data-hex="#64748b" value="uk-theme-slate">
                        Slate
                      </option>
                      <option data-hex="#78716c" value="uk-theme-stone">
                        Stone
                      </option>
                      <option data-hex="#6b7280" value="uk-theme-gray">
                        Gray
                      </option>
                      <option data-hex="#737373" value="uk-theme-neutral">
                        Neutral
                      </option>
                      <option data-hex="#dc2626" value="uk-theme-red">
                        Red
                      </option>
                      <option data-hex="#e11d48" value="uk-theme-rose">
                        Rose
                      </option>
                      <option data-hex="#f97316" value="uk-theme-orange">
                        Orange
                      </option>
                      <option data-hex="#16a34a" value="uk-theme-green">
                        Green
                      </option>
                      <option data-hex="#2563eb" value="uk-theme-blue">
                        Blue
                      </option>
                      <option data-hex="#facc15" value="uk-theme-yellow">
                        Yellow
                      </option>
                      <option data-hex="#7c3aed" value="uk-theme-violet">
                        Violet
                      </option>
                    </optgroup>

                    <optgroup data-key="mode" label="Mode" class="p-2">
                      <option data-icon="sun" value="light">
                        Light
                      </option>
                      <option data-icon="moon" value="dark">
                        Dark
                      </option>
                    </optgroup>
                  </select>
                </uk-theme-switcher>
              </ul>
            </div>

            <LanguageDropdown className="ml-2" />
          </div>
        </div>

        {/* Children unaffected */}
        <div class="flex flex-1 items-start justify-center mt-12  ">{children}</div>
      </div>

      <div class="relative bg-muted lg:block">
        {/* Placeholder for a cover image: bg-cover/bg-center are set but no
            background-image, so today this renders as a plain muted column. */}
        <div
          class="absolute inset-0 bg-cover bg-center"
        ></div>
        <div class="absolute inset-0 bg-gradient-to-t from-muted to-transparent"></div>
      </div>
    </div>
  );
};
