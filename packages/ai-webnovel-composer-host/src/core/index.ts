/**
 * The pure core, re-exported from one specifier.
 *
 * The tool layer imports the domain from here rather than reaching into five
 * modules, which keeps the dependency direction visible: `core` never imports
 * `host`, and `host` imports `core` in exactly one shape.
 *
 * @module @ai-webnovel/composer-host/core
 */

export * from './types.ts'
export * from './novel.ts'
export * from './plan.ts'
export * from './metrics.ts'
export * from './write.ts'
export * from './review.ts'
export * from './repo.ts'
export * from './workspace.ts'
