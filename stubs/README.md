# stubs/

Temporary build stubs for three `@deepseek-ai` packages that the npm registry
does not carry yet but published rc.1 packages declare (`@deepseek-ai/dsh-compact`,
`@deepseek-ai/dsh-type-meta`, `@deepseek-ai/dsh-environment`). Their declared
bundled output never imports these modules at runtime, so an empty module is
enough to satisfy install.

The root `package.json#pnpm.overrides` maps each missing package to its stub.
Delete this directory and the `pnpm.overrides` block once the upstream registry
is complete.
