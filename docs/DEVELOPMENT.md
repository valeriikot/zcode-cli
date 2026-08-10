# Local development

This document covers setting up a development environment for zcode-app-cli.
For installation as an end user, see the [main README](../README.md).

## Prerequisites

Developing or publishing from source requires Bun 1.3 or newer. `7z` is needed
only when downloading and extracting a remote installer.

## Quick start

Install dependencies, then run the client with live TypeScript and auto-sync
from the local ZCode Desktop installation:

```bash
bun install
bun run dev
```

`bun run dev` runs `sync:local` (rebuild + extract `resources/glm` from
`/Applications/ZCode.app`) and then starts the client through `bun bin/zcode.ts`
with `ZCODE_NODE=node`, so source changes take effect on the next launch
without a manual build step.

## Validation

Run all validation layers:

```bash
bun run typecheck
bun test
bun run check
bun run check:tui
```

`check:tui` runs real-PTY scenarios. The official runtime scenario completes
masked Coding Plan API-key setup in a temporary home, verifies the official
config output, executes `/help`, switches to plan mode, exits, and checks that
the launcher forwards terminal SIGHUP shutdown. The offline
feature scenario also covers suspended login restoration, selectors, image
attachments, nested Agent tools, Markdown, Mermaid, diffs, transcript
navigation, context/status details, MCP actions, background tasks and the
workflow panel. A pressure scenario verifies that steering, UTF-8 input and
Ctrl+C cancellation remain responsive during rapid Bash progress output. The
scenarios advance from observed terminal output instead of fixed timers and do
not make model API calls.

## OAuth login

For the OAuth path, run the launcher directly with the login subcommand:

```bash
bun bin/zcode.ts login --oauth
bun run dev
```

To print the authorization URL without launching the browser:

```bash
bun bin/zcode.ts login --oauth --no-browser
```

The URL must still be opened on the same Mac so its `zcode://` callback reaches
the waiting CLI. Cross-device SSH login is not supported by this provider flow;
use the masked Z.AI Coding Plan API-key option instead. The wrapper no longer
uses the upstream `oauth/cli/init` polling endpoint, which currently returns
HTTP 404.

Verify native callback capture and automatic handler restoration without
contacting Z.AI or changing the real `zcode://` association:

```bash
bun run check:oauth-callback
```

## Local command installation

Install a local `zcode` command:

```bash
bun link
zcode
```

Headless and protocol commands use the same inherited stdio path:

```bash
zcode --version
zcode doctor --json
zcode --prompt "Explain this repository"
zcode app-server
zcode plugins list --json
zcode plugins discover --json
zcode remote list --json
zcode remote serve --workspace .
```

Marketplace and install commands are launcher-owned adapters over the
runtime's public `app-server` NDJSON methods. Keep protocol framing in
`src/app-server-client.ts` and command parsing in `src/plugin-cli.ts`; do not
add these operations to the minified runtime bridge. The TUI queries
`plugins/referenceCatalog` through the same client and inserts native
`plugin://` links for `@` Plugin completion.

Browser automation is enabled by the launcher only for agent-producing
invocations:

```bash
zcode
zcode --prompt "Inspect https://example.com"
zcode --print "Inspect https://example.com"
zcode --browser-use=headless --browser-executable /path/to/chromium
```

The npm package supplies the runtime-compatible `playwright-core` library but
does not download a browser binary. Keep the executable discovery and launch
logic in the official runtime; use `--browser-executable` for environments
where the system Chrome/Chromium path is non-standard.

Keep the injection classifier covered when runtime global options change. Do
not add the flag to protocol or management commands; the runtime rejects it
outside TUI, `--prompt` and `--target` invocations.

`zcode version`, `zcode --version` and `zcode -v` identify both packaged
layers explicitly:

```text
zcode-app-cli 3.3.6-4
zcode-runtime 0.15.2
```

## Remote control development

The relay protocol implementation lives in `src/remote/`:

- `connection-params.ts` and `proof.ts` — pairing-URL parsing and redaction,
  plus the HMAC pairing proof shared by both roles;
- `relay-client.ts` — the persistent relay socket, authenticating as the
  `terminal` (controlling) or `desktop` (controllable) role;
- `rpc-transport.ts`, `ipc-codec.ts` and `channel-client.ts` — rpc-frame
  fragmentation with checksums, the IPC value codec and channel RPC;
- `client.ts` and `device-store.ts` — the controlling side behind
  `zcode remote add|list|connect|remove`;
- `host.ts` and `host-link.ts` — the controllable side behind
  `zcode remote link` and `zcode remote serve`.

Keep command parsing in `src/remote-cli.ts`. The launcher only supplies the
app-server request that `serve` uses: hosted channel calls are answered as
one-shot `<channel>/<name>` app-server requests, mirroring how the plugin
commands use `src/app-server-client.ts`. Remote-control URLs and the stored
`sid`/`hash` pairs are credentials — never let them reach logs, transcripts or
error messages; use the redacted summaries instead.

Every remote suite runs without opening a socket:

```bash
bun test remote
```

`test/remote-host.test.ts` ends with a loopback suite that pairs the real
`RemoteClient` with the real `RemoteHostService` through an in-memory relay.
Extend it whenever either side of the protocol changes, so the controlling and
controllable halves are proven to interoperate.

## OAuth login override

To hand `/login` to another interactive command, set an explicit override:

```bash
export ZCODE_TUI_LOGIN_CMD='zcode login --oauth'
```

The TUI then releases raw terminal mode, runs that command with inherited
stdio, restores the interface, and checks `~/.zcode/cli/config.json` again.

For the direct API-key path, follow
[Custom provider without login](./CONFIGURATION.md#custom-provider-without-login)
instead.

## Continuous integration

`.github/workflows/ci.yml` runs for pull requests, pushes to `main` and manual
dispatches. It validates the project on the minimum supported Node.js 22.19,
including the locked runtime build, TypeScript and unit tests, PTY scenarios,
the reviewed npm tarball and an isolated installed-package smoke test. A newer
commit to the same pull request or branch automatically cancels its superseded
CI run; unrelated pull requests continue independently.

The metadata step also confirms that `package.json` needs no npm normalization.
It runs `npm pkg fix` and fails if that rewrote the file, because `npm pkg fix`
offers no check mode: `--dry-run` reports the fixes it would apply but exits 0
and writes nothing, so a following `git diff` cannot observe them. Commit the
normalized metadata when this step fails.
