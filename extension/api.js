(function (root) {
  const PROTOCOL = "2";
  const CONNECTIONS = "t3Connections";
  const MAX_RESULTS = 200;
  const setupError = () => Object.assign(new Error("Connect to T3 Code in Settings to find your threads."), { needsSetup: true });

  function normalizeEndpoint(value) {
    if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a valid T3 endpoint URI.");
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error("Enter a full endpoint URI, such as http://127.0.0.1:3773."); }
    // A bare trailing "?" or "#" leaves search and hash empty but stays in href.
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) {
      throw new Error("Use an HTTP or HTTPS endpoint URI without credentials, a query, or a fragment.");
    }
    return url.href.replace(/\/+$/, "");
  }

  function permissionOrigin(endpoint) { return `${new URL(normalizeEndpoint(endpoint)).origin}/*`; }
  function endpointUrl(endpoint, path) { return `${endpoint}/${path.replace(/^\//, "")}`; }
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

  function repositoryKey(identity) {
    // T3 keeps a fork's own origin separate from its canonical upstream.
    const key = identity?.origin?.canonicalKey || identity?.canonicalKey;
    return typeof key === "string" ? key.toLowerCase().replace(/\.git$/, "") : null;
  }

  function threadLinks(thread) {
    const links = Array.isArray(thread.pullRequests) ? thread.pullRequests : thread.linkedPullRequest ? [thread.linkedPullRequest] : [];
    return links.flatMap(link => {
      if (!link || link.source === "stack-dismissed" || typeof link.repository !== "string" || !Number.isSafeInteger(link.number) || link.number < 1) return [];
      let host = link.host;
      if (!host) { try { host = new URL(link.url).hostname; } catch { return []; } }
      return typeof host === "string" && host.toLowerCase() === "github.com" && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(link.repository)
        ? [{ repository: link.repository.toLowerCase(), number: link.number }] : [];
    });
  }

  // T3 uses Effect 4's JSON RPC envelopes, not JSON-RPC 2.0. Only unary reads
  // are needed here; each operation closes its socket after completing.
  function openRpc(Socket, url, timeout = 12000) {
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = new Socket(url); } catch { reject(new Error("Could not open T3's WebSocket API.")); return; }
      const pending = new Map();
      let sequence = 0;
      let opened = false;
      let failure = null;
      const fail = error => {
        failure ||= error;
        clearTimeout(openTimer);
        if (!opened) reject(error);
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
      };
      const close = () => { fail(new Error("T3 connection closed.")); socket.close(); };
      const openTimer = setTimeout(() => { fail(new Error("T3's WebSocket connection timed out.")); socket.close(); }, timeout);
      socket.onopen = () => {
        clearTimeout(openTimer);
        opened = true;
        resolve({ close, call(tag, payload) {
          // A closed socket accepts send() silently; reject instead of waiting out the timer.
          if (failure) return Promise.reject(failure);
          return new Promise((resolveCall, rejectCall) => {
            const id = String(++sequence);
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error("T3's API request timed out."));
              close();
            }, timeout);
            pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
            try { socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] })); }
            catch { close(); }
          });
        } });
      };
      socket.onerror = () => { fail(new Error("Could not reach T3's WebSocket API. Check the endpoint and keep T3 running.")); socket.close(); };
      socket.onclose = () => fail(new Error("T3 closed the connection. Check your pairing and T3 version."));
      socket.onmessage = event => {
        let messages;
        try { const data = JSON.parse(event.data); messages = Array.isArray(data) ? data : [data]; }
        catch { fail(new Error("T3 returned an invalid API response.")); socket.close(); return; }
        for (const message of messages) {
          if (message._tag === "Ping") { socket.send(JSON.stringify({ _tag: "Pong" })); continue; }
          if (message._tag === "Defect") { fail(new Error("T3 could not process the API request. Check your T3 version.")); socket.close(); return; }
          if (message._tag !== "Exit") continue;
          const entry = pending.get(String(message.requestId));
          if (!entry) continue;
          pending.delete(String(message.requestId));
          clearTimeout(entry.timer);
          if (message.exit?._tag === "Success") entry.resolve(message.exit.value);
          else {
            const denied = message.exit?.cause?.some(reason => reason.error?.requiredScope);
            entry.reject(new Error(denied ? "Pair again with permission to read threads." : "T3 could not complete the lookup. Check your T3 version and workspace."));
          }
        }
      };
    });
  }

  // vcs.refreshStatus fetches, refreshes PR status and can auto-pull. vcs.listRefs
  // with refresh reads HEAD and local refs only, and sorts the checked-out branch first.
  async function checkedOutBranch(socket, cwd) {
    const result = await socket.call("vcs.listRefs", { cwd, refKind: "local", refresh: true, limit: 1 });
    const ref = Array.isArray(result?.refs) ? result.refs[0] : null;
    return { isRepo: result?.isRepo === true,
      refName: ref?.current === true && !ref.isRemote && typeof ref.name === "string" && ref.name
        && ref.name.length <= 1024 && !/[\x00-\x1f\x7f]/.test(ref.name) ? ref.name : null };
  }

  function create({ chrome, fetch: fetchApi, WebSocket: Socket, now = Date.now, timeout = 12000 }) {
    // GitHub content scripts get only filtered results and display preferences.
    // Access tokens stay in storage restricted to the extension's own contexts.
    const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    let mutations = Promise.resolve();
    const snapshots = new Map();
    const mutate = task => {
      const operation = mutations.then(task);
      mutations = operation.catch(() => {});
      return operation;
    };
    async function connections() {
      await storageReady;
      return (await chrome.storage.local.get(CONNECTIONS))[CONNECTIONS] || [];
    }
    function publicConnection({ id, name, endpoint, environmentId, expiresAt }) { return { id, name, endpoint, environmentId, expiresAt }; }
    // Give up site access once no saved connection uses that origin.
    async function releaseOrigin(endpoint, remaining) {
      const origin = permissionOrigin(endpoint);
      if (remaining.some(item => permissionOrigin(item.endpoint) === origin)) return;
      try { await chrome.permissions.remove({ origins: [origin] }); } catch { /* Settings can still remove access. */ }
    }
    async function request(endpoint, path, { token, method = "GET", body, headers = {} } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchApi(endpointUrl(endpoint, path), {
          method, body, signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
          headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (!response.ok) {
          if ([401, 403].includes(response.status)) throw new Error("Pairing expired, was revoked, or lacks read access. Pair again in Settings.");
          if (response.status === 426) throw new Error("This T3 version uses a different API protocol. Update T3 Code and the extension.");
          if (response.status === 404) throw new Error("The endpoint does not provide this T3 API. Check the URI and T3 version.");
          throw new Error(`T3 returned HTTP ${response.status}. Check the endpoint and pairing code.`);
        }
        return await response.json();
      } catch (error) {
        // Never echo server error bodies or request URLs containing credentials.
        if (error instanceof TypeError || error.name === "AbortError" || error instanceof SyntaxError) {
          throw new Error("Could not reach the T3 API. Keep T3 running and check the endpoint URI and site access.");
        }
        throw error;
      } finally { clearTimeout(timer); }
    }
    async function descriptor(endpoint, expectedId) {
      if (!await chrome.permissions.contains({ origins: [permissionOrigin(endpoint)] })) {
        throw new Error("Allow access to this endpoint by connecting again in Settings.");
      }
      const data = await request(endpoint, "/.well-known/t3/environment");
      if (!identifier(data.environmentId) || typeof data.serverVersion !== "string" || typeof data.label !== "string" || !data.label.trim()) throw new Error("This endpoint is not a compatible T3 Code server.");
      if (data.orchestrationProtocolVersion !== Number(PROTOCOL)) throw new Error("This T3 version uses a different API protocol. Update T3 Code and the extension.");
      if (expectedId && data.environmentId !== expectedId) throw new Error("This endpoint now reaches a different T3 environment. Pair again in Settings.");
      return data;
    }
    async function rpc(connection) {
      const result = await request(connection.endpoint, "/api/auth/websocket-ticket", { token: connection.token, method: "POST" });
      if (!identifier(result.ticket)) throw new Error("T3 did not return a WebSocket ticket.");
      const url = new URL(endpointUrl(connection.endpoint, "/ws"));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", result.ticket);
      url.searchParams.set("orchestrationProtocol", PROTOCOL);
      return openRpc(Socket, url.href, timeout);
    }
    async function connect(input) {
      return mutate(async () => {
        const endpoint = normalizeEndpoint(input?.endpoint);
        const saved = await connections();
        const existing = input.id ? saved.find(item => item.id === input.id) : saved.find(item => item.endpoint === endpoint);
        if (input.id && !existing) throw new Error("This connection was removed. Reload Settings.");
        if (!existing && saved.length >= 12) throw new Error("You can save up to 12 T3 connections.");
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (name.length > 200 || /[\x00-\x1f\x7f]/.test(name) || name === "all") throw new Error("Enter a valid display name other than 'all'.");
        const data = await descriptor(endpoint);
        const duplicate = saved.find(item => item.id !== existing?.id && (item.endpoint === endpoint || item.environmentId === data.environmentId));
        if (duplicate) throw new Error(`This T3 environment is already saved as ${duplicate.name}. Edit that connection instead.`);
        // A server label gets the same checks as a typed name, falling back to the host.
        const label = data.label.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
        const displayName = name || (label && label !== "all" ? label : new URL(endpoint).host);
        if (saved.some(item => item.id !== existing?.id && item.name === displayName)) throw new Error("Choose a unique display name for this connection.");
        const pairingCode = typeof input.pairingCode === "string" ? input.pairingCode.trim() : "";
        let token, expiresAt;
        if (pairingCode) {
          if (pairingCode.length > 8192) throw new Error("The pairing code is too long.");
          const result = await request(endpoint, "/oauth/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: pairingCode,
              subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
              requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              scope: "orchestration:read", client_label: "T3Code PR Links", client_device_type: "desktop",
            }).toString(),
          });
          if (result.token_type !== "Bearer" || typeof result.access_token !== "string" || !result.access_token
              || !result.scope?.split(" ").includes("orchestration:read") || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
            throw new Error("T3 did not grant a read-only access token. Generate a new pairing code.");
          }
          token = result.access_token;
          expiresAt = new Date(now() + result.expires_in * 1000).toISOString();
        } else {
          if (!existing || existing.endpoint !== endpoint || existing.environmentId !== data.environmentId) throw new Error("Enter a pairing code from T3 Code's Connections settings.");
          ({ token, expiresAt } = existing);
        }
        const connection = { id: existing?.id || crypto.randomUUID(), name: displayName,
          endpoint, environmentId: data.environmentId, token, expiresAt };
        // Save a redeemed one-time code's token before testing the remaining API,
        // so a transient failure does not force the user to mint another code.
        const next = [...saved.filter(item => item.id !== connection.id), connection];
        await chrome.storage.local.set({ [CONNECTIONS]: next });
        snapshots.clear();
        if (existing && existing.endpoint !== endpoint) await releaseOrigin(existing.endpoint, next);
        let warning;
        try {
          const socket = await rpc(connection);
          try { await socket.call("orchestration.getArchivedShellSnapshot", {}); } finally { socket.close(); }
        } catch (error) { warning = error.message; }
        return { ok: true, connection: publicConnection(connection), warning };
      });
    }
    async function loadSnapshot(connection) {
      if (snapshots.has(connection.id)) return snapshots.get(connection.id);
      const pending = (async () => {
        await descriptor(connection.endpoint, connection.environmentId);
        const socket = await rpc(connection);
        try {
          const [active, archived] = await Promise.all([
            request(connection.endpoint, "/api/orchestration/shell", { token: connection.token, headers: { "x-t3-orchestration-protocol": PROTOCOL } }),
            socket.call("orchestration.getArchivedShellSnapshot", {}),
          ]);
          if (!Array.isArray(active.threads) || !Array.isArray(active.projects) || !Array.isArray(archived.threads)) throw new Error("T3 returned incompatible thread metadata.");
          const projects = new Map([...(archived.projects || []), ...active.projects].map(project => [project.id, project]));
          const threads = new Map();
          for (const [items, isArchived] of [[archived.threads, true], [active.archivedThreads || [], true], [active.threads, false]]) {
            for (const thread of items) {
              if (!identifier(thread.id) || thread.deletedAt) continue;
              const project = projects.get(thread.projectId);
              // Drop message excerpts, provider state, and other unrelated fields immediately.
              threads.set(thread.id, { id: thread.id, environmentId: connection.environmentId, title: String(thread.title || "Untitled thread").slice(0, 300),
                projectId: thread.projectId, project: project?.title || "", branch: thread.branch || null,
                workspace: thread.worktreePath || project?.workspaceRoot || null, workspaceType: thread.worktreePath ? "worktree" : "workspace",
                repositoryKey: repositoryKey(project?.repositoryIdentity), pullRequests: threadLinks(thread),
                archived: isArchived || Boolean(thread.archivedAt), updatedAt: thread.updatedAt || null, computer: connection.name });
            }
          }
          return [...threads.values()];
        } finally { socket.close(); }
      })();
      snapshots.set(connection.id, pending);
      try { return await pending; } finally { if (snapshots.get(connection.id) === pending) snapshots.delete(connection.id); }
    }
    const rank = thread => ({ linked: 0, branch: 1, checkout: 2, repository: 3 })[thread.matchType] ?? 4;
    function sort(threads) { return threads.sort((a, b) => rank(a) - rank(b) || Number(a.archived) - Number(b.archived) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))); }
    function publicThread(thread) { const { repositoryKey: ignored, projectId: ignoredId, ...result } = thread; return result; }
    async function lookup(connection, input) {
      if (input.type === "status") {
        // Proves the descriptor, token, ticket and WebSocket without downloading thread metadata.
        await descriptor(connection.endpoint, connection.environmentId);
        (await rpc(connection)).close();
        return { threads: [] };
      }
      if (input.type === "checkoutLookup" && connection.environmentId !== input.environmentId) return { threads: [] };
      const threads = await loadSnapshot(connection);
      const warnings = [];
      if (input.type === "batchLookup") {
        const matches = {};
        for (const query of input.queries) {
          const key = `${query.repository}#${query.number}`;
          matches[key] = threads.filter(thread => thread.pullRequests.some(link => link.repository === query.repository && link.number === query.number))
            .map(thread => publicThread({ ...thread, matchType: "linked" }));
        }
        return { matches };
      }
      if (input.type === "checkoutLookup") {
        const thread = threads.find(item => item.id === input.threadId);
        if (!thread) return { threads: [] };
        let checkout;
        if (!thread.workspace) checkout = { state: "unavailable", error: "No saved workspace for this thread." };
        else {
          const socket = await rpc(connection);
          try {
            const status = await checkedOutBranch(socket, thread.workspace);
            checkout = !status.isRepo ? { state: "unavailable", error: "The saved workspace is not a Git repository." }
              : status.refName ? { state: "branch", branch: status.refName, matchesRecorded: thread.branch ? status.refName === thread.branch : null }
              : { state: "detached" };
          } catch (error) { checkout = { state: "unavailable", error: error.message }; }
          finally { socket.close(); }
        }
        return { threads: [publicThread({ ...thread, checkout })] };
      }
      const targetBranch = input.type === "branchLookup" ? { repository: input.repository, branch: input.branch } : input.head;
      const matches = new Map();
      for (const thread of threads) {
        const linked = input.type === "lookup" && thread.pullRequests.some(link => link.repository === input.repository && link.number === input.number);
        const repository = input.type === "repositoryLookup" && (thread.repositoryKey === `github.com/${input.repository}` || thread.pullRequests.some(link => link.repository === input.repository));
        const branch = targetBranch && thread.branch === targetBranch.branch && thread.repositoryKey === `github.com/${targetBranch.repository}`;
        if (linked || repository || branch) matches.set(thread.id, { ...thread, matchType: linked ? "linked" : branch ? "branch" : "repository",
          ...(branch && !linked ? { matchedBranch: targetBranch.branch } : {}) });
      }
      if (targetBranch && input.liveBranches !== false) {
        // Snapshots list archived threads first; check recently active workspaces within the limit.
        const candidates = threads.filter(thread => !matches.has(thread.id) && thread.workspace && thread.repositoryKey === `github.com/${targetBranch.repository}`)
          .sort((a, b) => Number(a.archived) - Number(b.archived) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
        const workspaces = [...new Set(candidates.map(thread => thread.workspace))];
        if (workspaces.length) {
          let socket;
          const statuses = new Map();
          try {
            socket = await rpc(connection);
            // Bound expensive server-side Git reads while preserving explicit links.
            const paths = workspaces.slice(0, 12);
            for (let index = 0; index < paths.length; index += 4) {
              await Promise.all(paths.slice(index, index + 4).map(async cwd => {
                try { const status = await checkedOutBranch(socket, cwd); statuses.set(cwd, status.isRepo ? status.refName : null); }
                catch { warnings.push("Some current workspace branches could not be checked."); }
              }));
            }
          } catch { warnings.push("Current workspace branches could not be checked. Recorded branches and PR links are still available."); }
          finally { socket?.close(); }
          if (workspaces.length > 12) warnings.push("Only the first 12 workspaces were checked for current branch matches. Recorded branches and PR links were checked on all threads.");
          for (const thread of candidates) if (statuses.get(thread.workspace) === targetBranch.branch) {
            matches.set(thread.id, { ...thread, matchType: "checkout", matchedBranch: targetBranch.branch });
          }
        }
      }
      return { threads: sort([...matches.values()]).map(publicThread), lookupWarnings: [...new Set(warnings)] };
    }
    async function aggregate(input) {
      const saved = await connections();
      if (!saved.length) throw setupError();
      const results = await Promise.all(saved.map(async connection => {
        try { return { connection, result: await lookup(connection, input) }; }
        catch (error) { return { connection, error: error.message }; }
      }));
      const environments = results.map(({ connection, error }) => ({ name: connection.name, ok: !error, ...(error ? { error } : {}) }));
      const ok = results.some(item => item.result);
      const warnings = [...new Set(results.flatMap(item => item.result?.lookupWarnings || []))];
      const result = { ok, environments, lookupWarnings: warnings, ...(ok ? {} : { error: "Could not reach any saved T3 endpoint. Check Settings and keep T3 running." }) };
      if (input.type === "batchLookup") {
        result.matches = {};
        let remaining = MAX_RESULTS;
        for (const query of input.queries) {
          const key = `${query.repository}#${query.number}`;
          const records = [...new Map(results.flatMap(item => item.result?.matches[key] || []).map(thread => [`${thread.environmentId}:${thread.id}`, thread])).values()];
          result.matches[key] = sort(records).slice(0, Math.min(10, remaining));
          remaining -= result.matches[key].length;
          if (records.length > result.matches[key].length) result.truncated = true;
        }
      } else {
        const records = [...new Map(results.flatMap(item => item.result?.threads || []).map(thread => [`${thread.environmentId}:${thread.id}`, thread])).values()];
        result.threads = sort(records).slice(0, MAX_RESULTS);
        result.truncated = records.length > MAX_RESULTS;
      }
      if (result.truncated) warnings.push("Some matching threads were omitted because the result limit was reached. Narrow the lookup to see more.");
      return result;
    }
    async function handle(input) {
      try {
        if (input.type === "getConfig") return { ok: true, config: { connections: (await connections()).map(publicConnection) } };
        if (input.type === "saveConfig") return await connect(input.config);
        if (input.type === "removeConnection") return await mutate(async () => {
          const saved = await connections();
          const remaining = saved.filter(item => item.id !== input.id);
          await chrome.storage.local.set({ [CONNECTIONS]: remaining });
          snapshots.clear();
          const removed = saved.find(item => item.id === input.id);
          if (removed) await releaseOrigin(removed.endpoint, remaining);
          return { ok: true };
        });
        return await aggregate(input);
      } catch (error) { return { ok: false, error: error.message, ...(error.needsSetup ? { needsSetup: true } : {}) }; }
    }
    return { handle, storageReady };
  }
  root.T3Api = { create, normalizeEndpoint, permissionOrigin, openRpc, threadLinks, repositoryKey };
  if (typeof module !== "undefined") module.exports = root.T3Api;
})(globalThis);
