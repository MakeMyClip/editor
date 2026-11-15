# Review integration test timeout

`tests/integration/timeline-review.test.ts` ("flags a cut planted mid-tone…") runs under vitest's default 5 s timeout but renders several FFmpeg steps, so it sometimes times out on a busy machine (seen once in two runs on `feat/shorts` at 18511f1). Give it an explicit timeout like the other integration tests (`120_000`).
