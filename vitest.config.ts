import { defineConfig } from "vitest/config";
import { compileModule } from "svelte/compiler";
import ts from "typescript";

export default defineConfig({
  plugins: [{
    name: "svelte-runes-modules",
    enforce: "pre",
    transform(source, id) {
      const filename = id.split("?")[0];
      const isRunesModule = filename.endsWith(".svelte.ts");
      const isRunesTest = filename.endsWith("/editor-state.test.ts");
      if (!isRunesModule && !isRunesTest) return null;
      const javascript = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
        },
        fileName: filename,
      }).outputText;
      const compiled = compileModule(javascript, {
        filename,
        generate: "client",
      });
      return {
        code: compiled.js.code,
        map: compiled.js.map ?? null,
      };
    },
  }],
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "examples/minimal/src/**/*.test.ts",
      "examples/minimal/src/**/*.test.tsx",
    ],
    environment: "node",
  },
});
