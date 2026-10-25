# T3Code PR Links

A Chrome extension that adds **Open in T3 Code** links to GitHub pull requests and branches. It connects directly to your running T3 Code server, on localhost or at a remote endpoint you choose.

An independent community extension for [T3 Code](https://github.com/pingdotgg/t3code), not affiliated with, endorsed by, or sponsored by T3 Code or its developers. Licensed under MIT.

## Install and connect

Requires Chrome 102 or newer and a running T3 Code server that supports orchestration protocol 2 and its shell snapshot APIs. There is no separate helper, Python installation, or terminal setup. This connection mode works across operating systems supported by Chrome and T3.

1. Install **T3Code PR Links** from the [Chrome Web Store](https://chromewebstore.google.com/detail/t3code-pr-links/bdjdijcodngjbkggknipjfccihmadpln). Its connection screen opens automatically when no endpoints are saved.
2. Enter your preferred **Endpoint URI**, such as `http://127.0.0.1:3773`. T3’s desktop app usually starts on port 3773 and selects a later port if that one is occupied. Use the actual server address shown in T3 for custom ports, development servers, or remote computers.
3. In T3’s **Settings → Connections → Authorized clients**, create a pairing code with permission to read threads. Paste that code into the extension, optionally give the endpoint a display name, and click **Connect**.
4. Allow Chrome to access that endpoint when prompted. Reload existing GitHub tabs.

Keep T3 Code running while looking up threads. Pairing grants the extension `orchestration:read` access. Tokens currently expire after approximately 30 days; if access expires or is revoked, open the extension’s **Settings**, select **Edit / pair again**, and paste a fresh code. The connection screen displays the expiry date returned by T3.

You can save up to 12 local or remote endpoints. Remote computers must run a reachable T3 server; use HTTPS for remote connections. SSH aliases and direct database access are no longer used. To open a remote thread using a `t3code://` link, the desktop app also needs to know that environment.

**Check saved connections** checks the saved endpoints without changing unsaved form fields. Removing a connection forgets its token in the extension; revoke its authorized client in T3 too if you want to invalidate server access. Editing the display name at the same endpoint can keep the existing pairing. Changing the endpoint requires a fresh code.

### SSH remote environments

A T3 environment connected over SSH runs its own server. Its threads are not included in the local server's shell snapshot, so pair that server as a separate endpoint. An SSH local port forward makes its loopback-only API reachable without exposing it to the network:

```sh
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:43773:127.0.0.1:3773 your-ssh-alias
```

Replace `your-ssh-alias` and, if necessary, the remote `3773` with the actual T3 port shown on that environment. The local `43773` can be any unused port. Keep the command running, then add `http://127.0.0.1:43773` as a connection in the extension. The pairing code must come from the remote environment, not the local one. On the remote machine, `t3 pair --scope orchestration:read --ttl 10m --label "T3Code PR Links"` creates a suitable short-lived code.

Keep the local endpoint paired as well to search both environments. The encrypted tunnel provides transport security, so HTTP on the local forwarded port is expected. To restore the tunnel after logout or reboot on macOS, run the same SSH command as a per-user `launchd` agent with `RunAtLoad` and `KeepAlive`; it will start at login and reconnect after failures. No native messaging helper or direct database access is involved.

If you installed the old native helper, it is no longer used. You can remove it with `python3 scripts/install.py --uninstall` from an older or current clone. Its stored SSH/data-directory settings are not converted automatically; pair the relevant T3 endpoints in the new connection screen.

## What matches

The extension reads active and archived thread metadata across all projects in each paired environment. Explicit PR links match the GitHub host, repository and PR number. Deleted threads and dismissed stack links are excluded. An empty current PR-link array stays empty even if a migrated legacy field contains an old link. PR URLs mentioned only in chat messages do not count as explicit links.

**Branch match** means the thread’s recorded branch and its project repository identity match the GitHub source branch and source repository. Forked PRs use the contributor repository. T3’s fork-origin identity takes precedence over its canonical upstream identity. These matches rely on T3’s saved metadata; they do not independently verify a branch’s Git tracking remote or imply that the thread created the PR.

With **Check current workspaces for branch matches** enabled, the extension also uses T3’s read-only VCS status API to check saved workspaces in the matching repository. These results are labeled **Workspace match**, after explicit PR links and recorded-branch matches. Live checks cover up to 12 distinct workspaces per endpoint; a visible warning reports skipped or failed checks. Explicit links and recorded branches are checked on all loaded threads.

Unavailable endpoints produce coverage warnings alongside results from available endpoints. Lookups return at most 200 threads; PR-list results are limited to 10 threads per PR and 200 in total. A visible warning reports omitted results. Only the first 100 visible PR rows are checked on a GitHub list.

## Using the extension

- The GitHub PR/branch panel shows matching thread links, computer names, and inferred branch matches. PR lists display badges beside linked PRs.
- The toolbar popup launches matching threads, groups PR-list results, and links source branches to an exact branch lookup. **Refresh** requests fresh metadata; there is no periodic polling.
- **Find threads** opens a repository browser. Enter `owner/repository`, a GitHub repository URL, or a PR URL; optionally supply an exact branch for a repository lookup. A pasted PR URL checks explicit links, while visiting the PR on GitHub also supplies its source branch.
- Display filters, sorting, and search apply to the loaded results. **Show all loaded threads** restores results hidden by filters. Changing live-workspace lookup rechecks an active branch query.
- **Check current checkout** asks T3 for the current branch of a thread’s saved workspace. It does not change that workspace.
- **Export shown links** downloads the displayed thread links, associated PR URLs, lookup timestamp, and coverage information as JSON.

Use **Alt+Shift+T** (Option+Shift+T on Mac) to open the toolbar popup. Configure shortcuts at `chrome://extensions/shortcuts`.

## Permissions and privacy

The extension uses local storage and a content script on github.com. Endpoint access is optional and requested when you connect a server. It uses HTTP requests and short-lived WebSocket tickets to read T3 metadata with a paired token. Tokens and settings stay in your Chrome profile, with token storage restricted to extension contexts. GitHub content scripts receive only display preferences and matching thread results.

T3’s shell snapshots include thread and project metadata and can include a latest-message excerpt. The extension discards excerpts and other unrelated fields immediately, does not fetch full conversations, and does not persist lookup results. No data is sent to the extension developer or an analytics service. See [PRIVACY.md](PRIVACY.md) for details.

## Development and release

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension`. Disable the store version while running the unpacked build. The manifest key retains the published extension ID. Pair the unpacked extension through its connection screen.

```sh
npm ci
npm test
npm run package
```

Node.js 22 or newer runs the tests. Python is used only for packaging and tests of the legacy helper and installer. The extension has no build step or runtime dependencies. The API integration test uses a synthetic HTTP/WebSocket server with T3’s Effect 4 RPC implementation; it never reads user T3 data or starts a T3 server.

Version 2.0.0 replaces native messaging and SSH/database lookups with paired T3 endpoints. Release versions must agree in `extension/manifest.json`, `package.json`, and `package-lock.json`. Packaging writes `dist/t3code-pr-links-<version>.zip`, without the manifest key, for upload in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).

The current API implementation targets orchestration protocol 2. The installed nightly `0.0.46-nightly.20261012.3010` advertised that protocol during development. Automated tests validate pairing, matching, partial failures, credential isolation, and real Effect RPC framing with synthetic data. Chrome pairing and the saved-connection check passed against that local nightly; matching links worked after refreshing the GitHub tab.

`python3 scripts/preview.py` serves sample-data previews of the GitHub panel, popup, thread browser, and connection screen. It never connects to T3. Stop it with Ctrl+C.

## Remove

Remove the extension at `chrome://extensions` and revoke its authorized client in T3’s Connections settings. Uninstalling removes the extension’s stored endpoints, access tokens, and display preferences.
