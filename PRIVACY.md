# Privacy policy

T3Code PR Links is an independent community extension for [T3 Code](https://github.com/pingdotgg/t3code), not affiliated with, endorsed by, or sponsored by T3 Code or its developers. It uses the T3 servers you choose to find and open matching threads. It does not sell your data or send it to the extension developer or analytics services.

## What the extension reads

- **GitHub pages:** the current page URL, repository, PR number, and source branch. On PR lists it also reads visible PR links and titles. This identifies matching T3 threads. It does not maintain browsing history or use a GitHub token.
- **Paired T3 servers:** environment identity and version, thread titles and identifiers, archived status, recorded branches, project/repository and workspace metadata, and linked PRs. When enabled or explicitly requested, it asks T3 which branch a saved workspace has checked out. T3 answers from local Git refs without fetching. T3’s shell API can also return a latest-message excerpt and unrelated state; these fields are discarded immediately. The extension does not fetch full conversations or display, store, or export those excerpts.

## Where data goes

The extension communicates directly with the endpoint URIs you configure using HTTP and WebSocket APIs. A local endpoint keeps this traffic on your computer. A remote endpoint sends API requests to that server and returns results to your browser; use HTTPS to encrypt remote traffic. Requests include your paired access token or a short-lived WebSocket ticket.

GitHub content scripts receive matching thread results and display preferences. The extension inserts thread titles, computer names, and links into GitHub pages. Endpoint credentials stay in the extension’s own contexts and are never sent to GitHub pages. No requests go to a developer-operated server or analytics service.

## What is stored

Chrome local storage contains your endpoint URIs, display names, environment IDs, paired access tokens and their expiry dates, and display preferences. This storage stays in your Chrome profile and is not synced. Storage access is restricted to the extension’s trusted contexts. Content scripts obtain display preferences through validated background messages.

Pairing requests `orchestration:read` access. The supplied pairing code is used to obtain a token and is not saved. Lookup results are held temporarily in memory; they are not persisted. **Export shown links** saves the selected results to a JSON file only when you request an export.

Removing a saved connection deletes its token from the extension and removes Chrome's access to that endpoint's site when no other saved connection uses it. Revoking the authorized client in T3 invalidates server access. Uninstalling the extension removes its Chrome storage. If you installed the native helper used by older versions, `python3 scripts/install.py --uninstall` removes that helper and its configuration; versions 2.0.0 and later do not use it.

## Changes and contact

Policy updates are published in this file in the [GitHub repository](https://github.com/callmemorgan/t3code-pr-links). For questions, [open an issue](https://github.com/callmemorgan/t3code-pr-links/issues).
