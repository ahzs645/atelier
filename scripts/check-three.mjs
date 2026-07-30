import { readFile } from "node:fs/promises";

const lockfile = await readFile(
  new globalThis.URL("../pnpm-lock.yaml", import.meta.url),
  "utf8",
);
const versions = new Set(
  [...lockfile.matchAll(/^ {2}three@([^:]+):/gm)].map((match) => match[1]),
);

if (versions.size !== 1) {
  throw new Error(
    `Expected one three.js version in pnpm-lock.yaml, found: ${[...versions].join(", ") || "none"}`,
  );
}

globalThis.console.log(`three.js lockfile version: ${[...versions][0]}`);
