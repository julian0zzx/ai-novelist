import { defineConfig } from 'vitest/config'

/**
 * Test configuration for the composer package.
 *
 * The default 5s per-test budget is too tight here for a load-dependent reason,
 * not a correctness one: the tool specs drive the **real** filesystem — every
 * `novel_plan` / `novel_write` call reads the project, rewrites the Markdown
 * files and the metadata document, and re-reads it — and a spec that walks the
 * twenty-competitor phase-one precondition makes thirty-odd such round trips.
 * Under a parallel run those cross 5s and fail as timeouts while passing alone,
 * which is a flake that punishes the wrong change.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
