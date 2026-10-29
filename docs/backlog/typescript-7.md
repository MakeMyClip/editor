# TypeScript 7

Move `typescript` to 7.x once tsup (or its successor) generates `.d.ts` without the TS 6 compiler API; tsup 9.0.0 still calls `parseJsonConfigFileContent` directly, so `pnpm build` fails even with `@typescript/typescript6` installed.
