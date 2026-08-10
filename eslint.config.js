import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ARCHITECTURE.md §3 dependency rules, enforced rather than aspirational.
 *
 * `geometry` and `core` must run headless in Node (decision D2), so they may not
 * import three.js. `io` may not depend on the viewport; its three-dependent
 * exporters live in the separate `src/three/` entry point (ARCHITECTURE §4.4).
 */
const noThree = {
  files: ["packages/geometry/**/*.ts", "packages/core/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "three", message: "geometry/core must stay three-free (D2)." },
        ],
        patterns: [
          { group: ["three/*", "@atelier/viewport*"], message: "geometry/core must stay three-free (D2)." },
        ],
      },
    ],
  },
};

const ioBoundary = {
  files: ["packages/io/src/**/*.ts"],
  ignores: ["packages/io/src/three/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [{ name: "three", message: "Only @atelier/io/three may import three (§4.4)." }],
        patterns: [{ group: ["three/*", "@atelier/viewport*"] }],
      },
    ],
  },
};

const noFrameworksInEngine = {
  files: [
    "packages/geometry/**/*.ts",
    "packages/core/**/*.ts",
    "packages/viewport/**/*.ts",
    "packages/render/**/*.ts",
    "packages/io/**/*.ts",
    "packages/sim/**/*.ts",
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      { patterns: [{ group: ["react", "react/*", "svelte", "svelte/*"], message: "Engine packages are framework-agnostic (D1)." }] },
    ],
  },
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
  noThree,
  ioBoundary,
  noFrameworksInEngine,
);
