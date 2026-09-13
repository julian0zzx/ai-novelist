/**
 * @ai-webnovel/composer — the profile bundle for the AI Web Novel Composer.
 *
 * A bundle is not a plugin: it carries `dsh.bundle.patch`, so installing this
 * package into a profile appends it to `dsh.profile.bundles`, and DSH composes
 * `cordis.patch.yml` (beside this file) over the layers before it. The patch
 * inserts the `@ai-webnovel/composer-host` row; the host package's plugin does
 * the actual work.
 *
 * This module exports nothing at runtime. It exists so the package is a valid
 * ES module with a resolvable entry point, which is what the profile's manifest
 * reader and `node --check` both expect.
 *
 * @module @ai-webnovel/composer
 */

export const bundleName = '@ai-webnovel/composer'

/** Package the patch inserts a loader row for. */
export const pluginPackage = '@ai-webnovel/composer-host'

/** Loader row id the patch inserts. */
export const pluginRowId = 'ai-webnovel-composer'
