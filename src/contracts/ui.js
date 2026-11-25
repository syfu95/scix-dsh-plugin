/**
 * Settings UI slot constants (dev brief §5). The Client half (owned by the UI
 * implementer) registers its Token input + Save/Verify form into these slots;
 * keys must match EXACTLY or the Configure control never appears.
 * @module contracts/ui
 */

/** Bundle package name = Client module id = plugins.bundle.config key. */
export const PACKAGE_NAME = 'scix-dsh-plugin'
/** Patch row id (cordis.patch.yml). */
export const ROW_ID = 'scix'

/** Keyed slot rendered on the bundle page between description and rows. */
export const SLOT_BUNDLE_CONFIG = 'plugins.bundle.config'
/** Key for SLOT_BUNDLE_CONFIG: the bare package name. */
export const BUNDLE_CONFIG_KEY = PACKAGE_NAME

/** Keyed slot giving the row a Configure control opening the row's page. */
export const SLOT_ROW_CONFIG = 'plugins.row.config'
/** Key for SLOT_ROW_CONFIG: '<package name>#<row id>'. */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ID}`

/**
 * Client wiring notes (brief §5–6):
 * - Register via ctx.slots.inject(ownerKey, () => ctx.slots.register({ name, key, locale }, Component))
 *   inside apply with ctx.effect/ctx.on cleanup; owner props are { view, form }.
 * - Forms render for view === 'page' only; the form owns its Save control.
 * - Config fields save through form.mutate(operations, expectedRevision).
 * - Token saves through ctx.remote.credentials.set(TOKEN_CREDENTIAL_REF, value)
 *   (existing Host namespace; values cross to Host only, no read path returns secrets).
 * - Verify calls ctx.remote[REMOTE_NAMESPACE][REMOTE_VERIFY_METHOD]()
 *   (see contracts/token.js for the exact constants).
 * - Style with --dsw-alias-* theme tokens; do NOT runtime-import ui-primitives.
 */