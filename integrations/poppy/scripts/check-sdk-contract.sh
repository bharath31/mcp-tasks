#!/usr/bin/env bash
set -euo pipefail
# Point to clean checkouts of the two pinned PRs; never install or modify them.
: "${AUTH0_AUTH_JS:?Set AUTH0_AUTH_JS to the pinned auth0-auth-js checkout}"
: "${NEXTJS_AUTH0:?Set NEXTJS_AUTH0 to the pinned nextjs-auth0 checkout}"
test "$(git -C "$AUTH0_AUTH_JS" rev-parse HEAD)" = 5cd394aefe4a1e99373a1ddd26fa28c8be3c2e71
test "$(git -C "$NEXTJS_AUTH0" rev-parse HEAD)" = 58d631efcf1329c700a20c78369eeb6edad45beb
test -z "$(git -C "$AUTH0_AUTH_JS" status --porcelain)"
test -z "$(git -C "$NEXTJS_AUTH0" status --porcelain)"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# These are the upstream exported declarations, not locally maintained fixtures.
# .d.ts plus skipLibCheck allows unrelated upstream imports to remain uninstalled.
cp "$AUTH0_AUTH_JS/packages/auth0-api-js/src/types.ts" "$tmp/api.d.ts"
cp "$NEXTJS_AUTH0/src/types/poppy.ts" "$tmp/browser.d.ts"
cat > "$tmp/contract.ts" <<END
import type { VerifyPoppyRequestOptions, VerifiedPoppyRequest } from './api.js';
import type { PoppyContext } from './browser.js';
import type { ApiClient, BrowserContext } from '$root/src/identity.js';
declare const upstream: (options: VerifyPoppyRequestOptions) => Promise<VerifiedPoppyRequest>;
const api: ApiClient = { verifyPoppyRequest: upstream };
declare const browser: PoppyContext;
const context: BrowserContext = browser;
void api; void context;
END
(cd "$tmp" && "$root/../../node_modules/.bin/tsc" --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext "$tmp/contract.ts")
echo 'Pinned upstream exported Poppy type compatibility passed'
