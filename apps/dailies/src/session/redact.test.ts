import { describe, expect, it } from "vitest";
import { namesCredential, REDACTED, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("replaces a password typed into a credential-named locator", () => {
    // Exactly what Playwright's recorder writes for a sign-in, which `session
    // takeover` stores as the step's script.
    const code = "await page.getByLabel('Password').fill('hunter2');";

    expect(redactSecrets(code)).toBe(
      `await page.getByLabel('Password').fill('${REDACTED}');`
    );
  });

  it("leaves ordinary typed values alone", () => {
    // The script IS the evidence — redacting it wholesale would take the
    // report's whole point with it.
    const code = [
      "await page.getByLabel('Email').fill('ada@example.com');",
      'await page.getByPlaceholder("Search").fill("invoices");',
    ].join("\n");

    expect(redactSecrets(code)).toBe(code);
  });

  it("finds the value in the two-argument selector form", () => {
    expect(
      redactSecrets("await page.humanFill('#user_password', 'hunter2');")
    ).toBe(`await page.humanFill('#user_password', '${REDACTED}');`);
    // …and does not mistake the selector itself for the value.
    expect(redactSecrets("await page.fill('#password', 'hunter2');")).toContain(
      "'#password'"
    );
  });

  it("reads a locator built inline without tripping over its arguments", () => {
    const code =
      "await page.getByRole('textbox', { name: 'Password' }).pressSequentially('hunter2');";

    expect(redactSecrets(code)).toContain(`pressSequentially('${REDACTED}')`);
    // The locator's own strings survive — they name the field, they aren't it.
    expect(redactSecrets(code)).toContain("{ name: 'Password' }");
  });

  it("covers the other typing methods and quote styles", () => {
    expect(
      redactSecrets('await page.locator("#api-key").type("sk-live-123");')
    ).toBe(`await page.locator("#api-key").type("${REDACTED}");`);
    expect(redactSecrets("await page.getByLabel('OTP').fill(`123456`);")).toBe(
      `await page.getByLabel('OTP').fill(\`${REDACTED}\`);`
    );
  });

  it("redacts each credential line of a multi-line capture independently", () => {
    const code = [
      "await page.getByLabel('Username').fill('ada');",
      "await page.getByLabel('Password').fill('hunter2');",
      "await page.getByRole('button', { name: 'Sign in' }).click();",
    ].join("\n");

    const out = redactSecrets(code).split("\n");
    expect(out[0]).toContain("'ada'");
    expect(out[1]).toContain(`'${REDACTED}'`);
    expect(out[2]).toContain("'Sign in'");
  });

  it("has nothing to do when the value came from a variable", () => {
    const code = "await page.getByLabel('Password').fill(secret);";
    expect(redactSecrets(code)).toBe(code);
  });

  it("returns non-code text unchanged", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("(no actions recorded)")).toBe(
      "(no actions recorded)"
    );
  });
});

describe("namesCredential", () => {
  it("matches the names a credential field actually has", () => {
    for (const name of [
      "Password",
      "user_password",
      "passcode",
      "client_secret",
      "api-key",
      "apiKey",
      "otp",
      "user_pin",
      "csrf_token",
    ]) {
      expect(namesCredential(name)).toBe(true);
    }
  });

  it("leaves ordinary fields alone", () => {
    for (const name of ["Email", "#search", "first_name", "quantity"]) {
      expect(namesCredential(name)).toBe(false);
    }
  });
});
