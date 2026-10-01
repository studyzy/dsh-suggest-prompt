# Security Policy

## Supported versions

The `main` branch is the only supported line. This plugin tracks a moving
upstream (`dsh`), so fixes land on `main` and are released from there.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability). If you cannot use that
channel, contact the maintainer at the address listed on their GitHub profile.

Please include:

- what the issue is and its impact,
- the affected version or commit,
- a reproduction (a failing test or the exact steps),
- any suggested fix.

You can expect an acknowledgement within a few days. Please allow a reasonable
window for a fix and a release before disclosing publicly.

## Scope

This plugin runs inside the DeepSeek Harness and handles conversation content.
Two areas are especially relevant:

- **Credential handling.** Suggestions are generated through an auxiliary model
  call. The transcript is redacted (`redactSecrets` in `src/sanitize.ts`) before
  it is sent, and the exact model-visible payload is recorded in the session log
  as a `suggest-prompt/request` event. A case where a secret reaches the model or
  the log *unredacted* is a security bug.
- **Session-log content.** The suggestion prompt is derived from conversation
  content. A path that leaks content into a place it should not appear — another
  session, the client wire payload, or a log line — is in scope.

Vulnerabilities in the harness itself, or in the upstream `@deepseek-ai/*`
packages, should be reported to the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) project
rather than here. Note that this repo pins specific harness versions; a
harness-side issue that this plugin merely triggers is usually best fixed
upstream.

## Non-issues

- A model producing a poor or unexpected suggestion. Suggestion quality is a
  prompt/model concern, not a vulnerability. Use the bug template instead.
- The plugin reading the conversation it is mounted on. That is its function.