import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const justfile = readFileSync("justfile", "utf8");

describe("admin password recipe", () => {
  test("updates an existing admin account instead of stopping on register conflict", () => {
    const recipeStart = justfile.indexOf("set-admin-password password:");
    expect(recipeStart).toBeGreaterThan(-1);

    const recipe = justfile.slice(recipeStart, justfile.indexOf("\n# Run all linters", recipeStart));
    const lookupIndex = recipe.indexOf("registered_users xmp.pm | grep -Fxq admin");
    const changeIndex = recipe.indexOf("change_password admin xmp.pm");
    const registerIndex = recipe.indexOf("register admin xmp.pm");

    expect(lookupIndex).toBeGreaterThan(-1);
    expect(changeIndex).toBeGreaterThan(lookupIndex);
    expect(registerIndex).toBeGreaterThan(changeIndex);
  });

  test("shell-quotes the password before sending it to ssh", () => {
    const recipeStart = justfile.indexOf("set-admin-password password:");
    const recipe = justfile.slice(recipeStart, justfile.indexOf("\n# Run all linters", recipeStart));

    expect(recipe).toContain("{{quote(password)}}");
    expect(recipe).not.toContain('"{{password}}"');
  });
});
