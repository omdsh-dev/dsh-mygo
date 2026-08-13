/**
 * tsdown preset for the dsh-mygo-panel client bundle. The shared clientBundle
 * helper lives in the dsh checkout (packages/client/tsdown.client.ts); the
 * build script resolves the checkout and exports DSH_CHECKOUT.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The checkout is this file's `vendor/dsh-mygo-panel/..`, so root `pnpm run
// build` can load this config without DSH_CHECKOUT being exported.
const checkout = process.env.DSH_CHECKOUT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { clientBundle } = await import(`${checkout}/packages/client/tsdown.client.ts`)

// Until the panel's own tsc run produces lib/types (via install.sh /
// build.mjs), skip it in the root workspace build; a missing entry would
// fail the client face otherwise.
const ready = existsSync(join(checkout, 'vendor/dsh-mygo-panel/lib/types/index.js'))
export default ready
  ? clientBundle('@dsh-external/dsh-mygo-panel', ['lib/types/index.js'])
  : () => []
