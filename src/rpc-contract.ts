/**
 * The RPC contract shared by this plugin's two halves.
 *
 * Deliberately free of host-only and browser-only imports: the host half
 * registers the route and the browser half calls it, and the client bundle may
 * only `require` the shell-seeded platform modules — so this module must stay
 * plain constants and types that both programs can include.
 * @module @studyzy/dsh-suggest-prompt/rpc-contract
 */

/**
 * Exact browser-facing path this plugin owns, dispatched by Connection's
 * shared `/api` gateway.
 *
 * It must sit under `/api` (`assertFetchRoute` rejects anything else), and it
 * is registered with `ctx.connection.fetch.register(...)` rather than
 * `ctx.connection.rpc.handle(...)`.
 *
 * That choice is not stylistic. `rpc.handle` registers an HTTP route through
 * `owner.webServer.register(...)`, where `owner` is the **connection service's
 * own fiber** — and that fiber injects `['credentials']` (package) plus
 * `[webRuntime]` (its profile row), never `webServer`. The read therefore
 * throws `cannot get property "webServer" without inject` inside `rpc.handle`
 * no matter what this plugin declares, and the plugin body is rolled back with
 * the session listener in it. `registerFetchRoute` only writes to the
 * connection's own `fetchRoutes` map, so it carries no such dependency — and
 * it is the surface the harness's own `dsh-client-file-upload` uses.
 */
export const SUGGEST_ROUTE_PATH = '/api/suggest-prompt'

/** Explicit, bounded generation for an existing idle session. */
export const SUGGEST_GENERATE_ROUTE_PATH = '/api/suggest-prompt/generate'

export type SuggestPromptGenerateStatus = 'generated' | 'empty' | 'busy' | 'no-context' | 'error'

export interface SuggestPromptGenerateResponse {
  readonly suggestion: import('./types.ts').SuggestPromptSuggestion | null
  readonly status: SuggestPromptGenerateStatus
}

/**
 * HTTP method the suggestion route answers. The browser half calls this with a
 * plain `fetch` through the ordinary `/api` gateway, so the route declares
 * exactly the one method it serves.
 */
export const SUGGEST_ROUTE_METHOD = 'POST'

/**
 * Endpoint returning the latest stored suggestion for one session.
 * Body `{ sessionId }`; the response carries the suggestion or `null`.
 */
export const SUGGEST_RPC_GET = 'get'