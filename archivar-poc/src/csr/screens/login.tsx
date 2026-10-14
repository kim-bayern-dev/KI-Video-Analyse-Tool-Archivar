import { createRef, $, Router, T as DefussT, t } from "defuss";
import type { FC, TransProps, VNode } from "defuss";
import {
  rule,
  transval,
  Rules,
  access,
  type FieldValidationMessage,
} from "defuss-transval";
import { InputLabel, Input, createNotification, Button } from "../../cl";
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../rpc.js";
import { loginUser } from "../stores/auth-store.js";

// defuss's `T` returns VNodeChild, which is not assignable to JSX.Element;
// narrow the type only — the runtime value is unchanged.
const T = DefussT as unknown as FC<TransProps<string>>;

// target datatype (values will be transformed to this type)
type LoginForm = {
  email: string;
  password: string;
  remember: boolean; // from "0" or "1" of form
};

// Custom validators for this login form.
// REFACTOR(kiss): neither validator is wired into the transval() chain in
// LoginScreen below, so they never run — and isEmailNotBlacklisted is a
// hardcoded demo simulation. Wire hasStrongPassword into the chain or drop
// the class before this ships.
class LoginValidators extends Rules {
  isEmailNotBlacklisted() {
    return (async (email: string) => {
      // async validator custom
      // For demo: simulate some emails as blacklisted
      const blacklistedEmails = ["admin@example.com", "test@test.com"];
      if (blacklistedEmails.includes(email)) {
        return t("login.email_blacklisted");
      }
      return true;
    }) as unknown as Rules & this;
  }

  // some custom password validation for strong passwords
  hasStrongPassword() {
    return ((password: string) => {
      if (password.length < 8) return t("login.password_min_length");
      if (!/[A-Z]/.test(password))
        return t("login.password_uppercase");
      if (!/[0-9]/.test(password))
        return t("login.password_number");
      return true;
    }) as unknown as Rules & this;
  }
}

function renderErrorBox(messages: FieldValidationMessage[]) {
  return (
    <div class="uk-alert uk-alert-destructive">
      <h4 class="uk-h6 mb-2"><T key="login.error_header" /></h4>
      <ul class="list-disc pl-4 space-y-1">
        {messages.map((msg) => (
          <li>
            <strong>{msg.path}:</strong> {msg.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Public login screen (route "/"). Validates the form with defuss-transval,
 * authenticates via RPC AuthApi.login, then stores the session (loginUser)
 * and navigates to /dashboard. Validation errors are shown both in a summary
 * box and per field; clearErrorStyles/renderFieldError keep the two in sync.
 */
export function LoginScreen() {
  // REFACTOR(kiss): signInBtnRef/continueWithGoogleBtnRef are never attached —
  // leftovers from a template that had a "Continue with Google" button.
  const signInBtnRef = createRef();
  const continueWithGoogleBtnRef = createRef();
  const formRef = createRef<HTMLFormElement>();
  const errorContainerRef = createRef<HTMLDivElement>();

  const form = access<LoginForm>();
  const formRule = rule.extend(LoginValidators);

  // Note: the "remember" checkbox is commented out in the JSX below, so
  // form.remember always validates undefined — that rule is inert today.
  const { isValid, getMessages, getData } = transval(
    formRule(form.email).isString().isEmail(),
    formRule(form.password).isString(),
    formRule(form.remember).asBoolean(),
  );

  const clearErrorStyles = (formFields: Array<string>) => {
    // Clear general error container
    $(errorContainerRef).empty().addClass("hidden");

    for (const fieldName of formFields) {
      $(`[data-field-error="${fieldName}"]`).empty();
      $(`input[name="${fieldName}"]`).removeClass("uk-form-destructive");
      $(`label[for="${fieldName}"]`).removeClass("text-destructive");
    }
  };

  const renderFieldError = (fieldName: string, errorMessage?: string) => {
    if (errorMessage) {
      // Render error message
      $(`[data-field-error="${fieldName}"]`).update(
        <div class="uk-anmt-shake uk-form-help text-destructive">
          {errorMessage}
        </div>,
      );

      // Add destructive styling
      $(`input[name="${fieldName}"]`).addClass("uk-form-destructive");
      $(`label[for="${fieldName}"]`).addClass("text-destructive");
    } else {
      // Clear error styling when no errors
      $(`[data-field-error="${fieldName}"]`).empty();
      $(`input[name="${fieldName}"]`).removeClass("uk-form-destructive");
      $(`label[for="${fieldName}"]`).removeClass("text-destructive");
    }
  };

  // Triggered from three paths: the sign-in button's onClick, the form's
  // onSubmit, and the manual Enter-key handler below. The cl Button renders
  // type="button" (src/cl/components/button.tsx), so the browser never
  // submits natively and onSubmit is only a safety net.
  const handleSignIn = async (e?: Event) => {
    if (e) e.preventDefault();
    const formValues = $(formRef).form<LoginForm>();

    clearErrorStyles(["email", "password"]);

    // Validate the form data
    if (await isValid(formValues)) {
      // Call server-side auth via RPC
      const rpc = await getRpcClient<RpcApi>();
      const authApi = new rpc.AuthApi();
      const result = await authApi.login(formValues.email, formValues.password);

      if (result.success && result.user) {
        loginUser(result.user);
        createNotification(t("login.success_message"), "success");
        Router.navigate("/dashboard");
      } else {
        $(errorContainerRef)
          .update(
            renderErrorBox([
              { path: "credentials", message: result.error || t("login.invalid_credentials") },
            ]),
          )
          .removeClass("hidden");
        createNotification(t("login.invalid_credentials"), "destructive");
      }
    } else {
      const messages = getMessages();

      if (messages.length > 0) {
        $(errorContainerRef)
          .update(renderErrorBox(messages))
          .removeClass("hidden");
      }

      // additionally, render errors for each field too (first error only)
      const formFields = [...new Set(messages.map((msg) => msg.path))];

      for (const fieldName of formFields) {
        const fieldErrors = getMessages(fieldName);
        const errorMessage =
          fieldErrors.length > 0 ? fieldErrors[0].message : undefined;
        renderFieldError(fieldName, errorMessage);
      }

      // Toast notification for general errors
      createNotification(t("login.form_error_message"), "destructive");
    }
  };

  const onFormRender = () => {
    $(formRef)
      .query("input")
      .on("keydown", (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") {
          e.preventDefault();
          handleSignIn(e);
        }
      });
  };

  return (
    <div class="w-full max-w-sm">
      <div class="flex flex-col items-center gap-4 text-center">
        <h1 class="uk-h4"><T key="common.app_name" /></h1>
        <h3 class="text-muted-foreground">
          <T key="login.welcome_message" />
        </h3>
      </div>
      <form
        onMount={onFormRender}
        onSubmit={handleSignIn}
        class="mt-6 space-y-6"
        ref={formRef}
      >
        <div ref={errorContainerRef} class="hidden">
          {/* Dynamic error messages will be rendered here */}
        </div>
        <div class="grid gap-y-1">
          <InputLabel for="email">{(<T key="login.email_label" />) as unknown as VNode}</InputLabel>
          <Input
            id="email"
            name="email"
            value=""
            type="email"
            placeholder={t("login.email_placeholder")}
          />

          <div data-field-error="email">
            {/* Email validation errors will be rendered here */}
          </div>
        </div>
        {/* REFACTOR(consistency): the email field above uses the cl
            <Input>/<InputLabel> components while password uses a raw
            <input>/<label> with hand-written uk-* classes — same form, two
            conventions; pick one. */}
        <div class="grid gap-y-1">
          <label class="uk-form-label" for="password">
            <T key="login.password_label" />
          </label>
          <input
            class="uk-input"
            id="password"
            name="password"
            type="password"
            placeholder={t("login.password_placeholder")}
          />
          <div data-field-error="password">
            {/* Password validation errors will be rendered here */}
          </div>
        </div>

        {/* Remember me and forgot password link 
        <div class="uk-text-small flex justify-between">
          <label for="remember">
            <input name="remember" type="hidden" value="0" />
            <input
              class="uk-checkbox mr-1"
              id="remember"
              name="remember"
              type="checkbox"
              value="1"
            />
            Remember me
          </label>
          <a class="uk-link" href="#">
            {" "}
            Can't login?{" "}
          </a>

        </div>
        */}

        <Button
          onClick={handleSignIn}
          type="primary"
          fullWidth
          className="block w-full"
        >
          <T key="login.sign_in_button" />
        </Button>
      </form>
    </div>
  );
}
