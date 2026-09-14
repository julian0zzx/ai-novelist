/**
 * @ai-novelist/novelist-bundle — the profile bundle for the AI Web Novel Composer.
 *
 * A bundle is not a plugin: it carries `dsh.bundle.patch`, so installing this
 * package into a profile appends it to `dsh.profile.bundles`, and DSH composes
 * `cordis.patch.yml` (beside this file) over the layers before it. The patch
 * inserts the `@ai-novelist/novelist-skill` row; the host package's plugin does
 * the actual work.
 *
 * This module exports nothing at runtime. It exists so the package is a valid
 * ES module with a resolvable entry point, which is what the profile's manifest
 * reader and `node --check` both expect.
 *
 * @module @ai-novelist/novelist-bundle
 */

export const bundleName = '@ai-novelist/novelist-bundle'

/** Package the patch inserts a loader row for. */
export const pluginPackage = '@ai-novelist/novelist-skill'

/** Loader row id the patch inserts. */
export const pluginRowId = 'ai-novelist'
