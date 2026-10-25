const { test } = require("node:test");
const assert = require("node:assert/strict");
const { create, normalizeEndpoint, permissionOrigin, openRpc, threadLinks } = require("../extension/api.js");
const connection = { id: "local", name: "This computer", endpoint: "http://127.0.0.1:3773", environmentId: "env", token: "secret-access", expiresAt: "2026-11-13T00:00:00Z" };
const descriptor = { environmentId: "env", label: "My T3", serverVersion: "0.0.45", orchestrationProtocolVersion: 2 };
const project = { id: "p1", title: "Project", workspaceRoot: "/repo", repositoryIdentity: { canonicalKey: "github.com/owner/repo" } };
function thread(id, values = {}) { return { id, projectId: "p1", title: id, branch: "feature/work", updatedAt: "2026-10-13T00:00:00Z", ...values }; }
const link = { host: "github.com", repository: "Owner/Repo", number: 42, source: "manual" };
const tick = () => new Promise(resolve => setImmediate(resolve));
const refs = (name, current = true) => ({ isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 1,
  refs: [{ name, current, isDefault: !current, worktreePath: null }] });
function harness({ saved = [connection], active = [], archived = [], projects = [project], allowed = true, http, rpc, socketFailure = false } = {}) {
  const data = { t3Connections: structuredClone(saved) };
  const requests = [], frames = [], sockets = [], accessLevels = [], removedOrigins = [];
  const chrome = { storage: { local: {
    async setAccessLevel(value) { accessLevels.push(value); },
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, structuredClone(value)); },
  } }, permissions: { async contains() { return allowed; }, async remove({ origins }) { removedOrigins.push(...origins); return true; } } };
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => socketFailure ? this.onerror?.() : this.onopen?.()); }
    send(text) {
      const frame = JSON.parse(text); frames.push(frame);
      if (frame._tag !== "Request") return;
      let value, error;
      try {
        value = rpc?.(frame, this.url);
        if (value === undefined) value = frame.tag === "orchestration.getArchivedShellSnapshot" ? { projects, threads: archived } : refs("feature/work");
      } catch (cause) { error = cause; }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ _tag: "Exit", requestId: frame.id,
        exit: error ? { _tag: "Failure", cause: [{ _tag: "Fail", error: { detail: error.message } }] } : { _tag: "Success", value } }) }));
    }
    close() { this.closed = true; this.onclose?.(); }
  }
  async function fetch(url, options) {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const custom = http?.(path, options, url);
    if (custom) return custom;
    const body = path.endsWith("/.well-known/t3/environment") ? descriptor
      : path.endsWith("/oauth/token") ? { access_token: "new-secret", token_type: "Bearer", expires_in: 2592000, scope: "orchestration:read" }
      : path.endsWith("/api/auth/websocket-ticket") ? { ticket: "short-ticket" }
      : { projects, threads: active, archivedThreads: [] };
    return { ok: true, async json() { return structuredClone(body); } };
  }
  const api = create({ chrome, fetch, WebSocket: Socket, now: () => Date.parse("2026-10-13T00:00:00Z"), timeout: 100 });
  return { api, data, requests, frames, sockets, accessLevels, removedOrigins };
}

test("endpoint normalization supports custom ports, IPv6 and proxy paths while rejecting embedded credentials", () => {
  assert.equal(normalizeEndpoint(" http://localhost:7940/ "), "http://localhost:7940");
  assert.equal(normalizeEndpoint("https://t3.example.test/backend/"), "https://t3.example.test/backend");
  assert.equal(permissionOrigin("http://[::1]:3773/"), "http://[::1]:3773/*");
  for (const value of ["localhost:3773", "file:///tmp/data", "javascript:alert(1)", "http://user:secret@localhost", "http://localhost/?token=secret", "https://host/#secret", "http://127.0.0.1:3773/?", "http://127.0.0.1:3773/#"]) assert.throws(() => normalizeEndpoint(value));
});

test("empty settings return an explicit setup state without contacting a server", async () => {
  const h = harness({ saved: [] });
  const result = await h.api.handle({ type: "status" });
  assert.equal(result.needsSetup, true);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
});

test("pairing requests only read scope, stores the access token and never exposes credentials in settings", async () => {
  const h = harness({ saved: [] });
  const result = await h.api.handle({ type: "saveConfig", config: { endpoint: "http://localhost:7940/", pairingCode: "one-time-code", name: "Local T3" } });
  assert.equal(result.ok, true);
  const exchange = h.requests.find(item => item.url.endsWith("/oauth/token"));
  const form = new URLSearchParams(exchange.options.body);
  assert.equal(form.get("subject_token"), "one-time-code");
  assert.equal(form.get("scope"), "orchestration:read");
  assert.equal(exchange.options.credentials, "omit");
  assert.equal(exchange.options.redirect, "error");
  assert.equal(h.data.t3Connections[0].token, "new-secret");
  assert.equal(h.data.t3Connections[0].expiresAt, "2026-11-12T00:00:00.000Z");
  assert.equal(JSON.stringify(h.data).includes("one-time-code"), false);
  assert.equal(JSON.stringify(result).includes("new-secret"), false);
  const settings = await h.api.handle({ type: "getConfig" });
  assert.equal(JSON.stringify(settings).includes("secret"), false);
  assert.equal(settings.config.connections[0].endpoint, "http://localhost:7940");
  assert.ok(h.sockets.every(socket => socket.closed));
});

test("token is saved even if subsequent verification fails, and removed without altering preferences", async () => {
  const h = harness({ saved: [], socketFailure: true });
  h.data.preferences = { includeArchived: false };
  const result = await h.api.handle({ type: "saveConfig", config: { endpoint: connection.endpoint, pairingCode: "code" } });
  assert.equal(result.ok, true);
  assert.match(result.warning, /WebSocket/);
  assert.equal(h.data.t3Connections[0].token, "new-secret");
  await h.api.handle({ type: "removeConnection", id: result.connection.id });
  assert.deepEqual(h.data.t3Connections, []);
  assert.deepEqual(h.data.preferences, { includeArchived: false });
});

test("pairing errors and denied site access leave saved connections intact without leaking server messages", async () => {
  const denied = harness({ allowed: false });
  assert.equal((await denied.api.handle({ type: "saveConfig", config: { endpoint: connection.endpoint, pairingCode: "code" } })).ok, false);
  assert.equal(denied.requests.length, 0);
  const h = harness({ http: path => path === "/oauth/token" ? { ok: false, status: 401, async json() { return { detail: "secret-code" }; } } : undefined });
  const result = await h.api.handle({ type: "saveConfig", config: { id: "local", endpoint: connection.endpoint, pairingCode: "secret-code" } });
  assert.match(result.error, /Pairing expired/);
  assert.equal(result.error.includes("secret-code"), false);
  assert.equal(h.data.t3Connections[0].token, "secret-access");
});

test("changed environment and protocol are rejected before credentials are sent", async () => {
  for (const patch of [{ environmentId: "other" }, { orchestrationProtocolVersion: 3 }, { orchestrationProtocolVersion: undefined }]) {
    const h = harness({ http: path => path === "/.well-known/t3/environment" ? { ok: true, async json() { return { ...descriptor, ...patch }; } } : undefined });
    const result = await h.api.handle({ type: "lookup", repository: "owner/repo", number: 42 });
    assert.equal(result.ok, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.headers.Authorization, undefined);
  }
});

test("PR matching includes archived and cross-project links but excludes deleted, dismissed and stale legacy links", async () => {
  const h = harness({ active: [thread("linked", { pullRequests: [link], latestVisibleMessage: { text: "private message" } }),
    thread("dismissed", { pullRequests: [{ ...link, source: "stack-dismissed" }] }),
    thread("unlinked", { pullRequests: [], linkedPullRequest: { ...link, url: "https://github.com/owner/repo/pull/42" } }),
    thread("deleted", { pullRequests: [link], deletedAt: "2026-10-12" }),
    thread("wrong-host", { pullRequests: [{ ...link, host: "gitlab.com" }] }),
    thread("wrong-repo", { pullRequests: [{ ...link, repository: "other/repo" }] }),
    thread("different-project", { projectId: "p2", pullRequests: [link] })], archived: [thread("archived", { pullRequests: [link] })] });
  const result = await h.api.handle({ type: "lookup", repository: "owner/repo", number: 42, liveBranches: false });
  assert.deepEqual(result.threads.map(thread => thread.id).sort(), ["archived", "different-project", "linked"]);
  assert.equal(result.threads.find(thread => thread.id === "archived").archived, true);
  assert.equal(JSON.stringify(result).includes("private message"), false);
  assert.equal(JSON.stringify(result).includes("secret-access"), false);
  assert.equal(JSON.stringify(result).includes("repositoryKey"), false);
  assert.equal(h.requests.find(item => item.url.endsWith("/api/orchestration/shell")).options.headers["x-t3-orchestration-protocol"], "2");
  assert.equal(new URL(h.sockets[0].url).searchParams.get("orchestrationProtocol"), "2");
  assert.equal(new URL(h.sockets[0].url).searchParams.get("wsTicket"), "short-ticket");
  assert.equal(h.frames[0]._tag, "Request");
  assert.deepEqual(h.frames[0].headers, []);
  assert.ok(h.sockets.every(socket => socket.closed));
});

test("recorded branch and live workspace matches respect fork origin and explicit PR priority", async () => {
  const fork = { ...project, id: "fork", repositoryIdentity: { canonicalKey: "github.com/owner/repo", origin: { canonicalKey: "github.com/contributor/repo" } } };
  const h = harness({ projects: [project, fork], active: [thread("wrong-repository"),
    thread("recorded", { projectId: "fork" }), thread("live", { projectId: "fork", branch: "old", worktreePath: "/fork-worktree" }),
    thread("explicit", { projectId: "fork", pullRequests: [link] })] });
  const result = await h.api.handle({ type: "lookup", repository: "owner/repo", number: 42, head: { repository: "contributor/repo", branch: "feature/work" } });
  assert.deepEqual(result.threads.map(thread => [thread.id, thread.matchType]), [["explicit", "linked"], ["recorded", "branch"], ["live", "checkout"]]);
  assert.equal(result.threads[2].branch, "old");
  assert.equal(result.threads[2].matchedBranch, "feature/work");
  // Live checks read local refs; vcs.refreshStatus fetches and can auto-pull.
  assert.deepEqual(h.frames.find(frame => frame.tag === "vcs.listRefs").payload, { cwd: "/fork-worktree", refKind: "local", refresh: true, limit: 1 });
  assert.equal(h.frames.some(frame => frame.tag === "vcs.refreshStatus"), false);
  const noLive = await h.api.handle({ type: "branchLookup", repository: "contributor/repo", branch: "feature/work", liveBranches: false });
  assert.deepEqual(noLive.threads.map(thread => thread.id).sort(), ["explicit", "recorded"]);
});

test("repository lookups include associated PRs and current checkout checks use server metadata", async () => {
  const h = harness({ active: [thread("recorded"), thread("cross-project", { projectId: "other", pullRequests: [link] })] });
  const result = await h.api.handle({ type: "repositoryLookup", repository: "owner/repo" });
  assert.equal(result.threads.length, 2);
  assert.ok(result.threads.every(thread => thread.matchType === "repository"));
  const checkout = await h.api.handle({ type: "checkoutLookup", environmentId: "env", threadId: "recorded" });
  assert.deepEqual(checkout.threads[0].checkout, { state: "branch", branch: "feature/work", matchesRecorded: true });
});

test("a failing live Git read preserves explicit matches and reports incomplete lookup", async () => {
  const h = harness({ active: [thread("explicit", { pullRequests: [link] }), thread("live", { branch: "old" })], rpc: frame => {
    if (frame.tag === "vcs.listRefs") throw Error("private path in server error");
  } });
  const result = await h.api.handle({ type: "lookup", repository: "owner/repo", number: 42, head: { repository: "owner/repo", branch: "feature/work" } });
  assert.equal(result.ok, true);
  assert.equal(result.threads[0].id, "explicit");
  assert.equal(result.lookupWarnings.length, 1);
  assert.equal(JSON.stringify(result).includes("private path"), false);
});

test("partial endpoint failures preserve available matches and batch limits remain visible", async () => {
  const remote = { ...connection, id: "remote", name: "Remote", endpoint: "https://remote.test" };
  const h = harness({ saved: [connection, remote], active: Array.from({ length: 15 }, (_, index) => thread(`thread-${index}`, { pullRequests: [link] })), http: (_, __, url) => url.startsWith("https://remote.test") ? { ok: false, status: 503 } : undefined });
  const result = await h.api.handle({ type: "batchLookup", queries: [{ repository: "owner/repo", number: 42 }] });
  assert.equal(result.ok, true);
  assert.equal(result.environments[1].ok, false);
  assert.equal(result.matches["owner/repo#42"].length, 10);
  assert.equal(result.truncated, true);
  assert.match(result.lookupWarnings.at(-1), /omitted/);
});

test("renaming at the same endpoint retains the token, changing the endpoint needs a fresh code", async () => {
  const h = harness();
  const result = await h.api.handle({ type: "saveConfig", config: { id: "local", endpoint: connection.endpoint, name: "New name" } });
  assert.equal(result.ok, true);
  assert.equal(h.data.t3Connections[0].token, "secret-access");
  assert.equal(h.requests.some(item => item.url.endsWith("/oauth/token")), false);
  const changed = await h.api.handle({ type: "saveConfig", config: { id: "local", endpoint: "https://different.test" } });
  assert.equal(changed.ok, false);
  assert.equal(h.data.t3Connections[0].endpoint, connection.endpoint);
});

test("simultaneous snapshot lookups share in-flight reads and refreshes fetch new metadata", async () => {
  const active = [thread("linked", { pullRequests: [link] })];
  const h = harness({ active });
  await Promise.all([h.api.handle({ type: "lookup", repository: "owner/repo", number: 42 }), h.api.handle({ type: "repositoryLookup", repository: "owner/repo" })]);
  assert.equal(h.requests.filter(item => item.url.endsWith("/api/orchestration/shell")).length, 1);
  active.length = 0;
  const refreshed = await h.api.handle({ type: "lookup", repository: "owner/repo", number: 42 });
  assert.equal(refreshed.threads.length, 0);
  assert.equal(h.requests.filter(item => item.url.endsWith("/api/orchestration/shell")).length, 2);
});

test("unary RPC correlates out-of-order responses, handles batched frames and closes timed-out sockets", async () => {
  let socket;
  class Socket {
    constructor() { socket = this; this.sent = []; queueMicrotask(() => this.onopen()); }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const client = await openRpc(Socket, "ws://localhost/ws", 30);
  const first = client.call("first", {}), second = client.call("second", {});
  socket.onmessage({ data: JSON.stringify([{ _tag: "Exit", requestId: "2", exit: { _tag: "Success", value: "second-result" } }, { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: "first-result" } }]) });
  assert.deepEqual(await Promise.all([first, second]), ["first-result", "second-result"]);
  socket.onmessage({ data: JSON.stringify({ _tag: "Ping" }) });
  assert.deepEqual(socket.sent.at(-1), { _tag: "Pong" });
  await assert.rejects(client.call("never", {}), /timed out/);
  assert.equal(socket.closed, true);
});

test("legacy links infer GitHub host while an empty modern link array remains unlinked", () => {
  const legacy = { linkedPullRequest: { repository: "Owner/Repo", number: 42, url: "https://github.com/Owner/Repo/pull/42" } };
  assert.deepEqual(threadLinks(legacy), [{ repository: "owner/repo", number: 42 }]);
  assert.deepEqual(threadLinks({ ...legacy, pullRequests: [] }), []);
});

test("live checks try active, recently updated workspaces first and read a detached HEAD as no branch", async () => {
  const archived = Array.from({ length: 13 }, (_, index) => thread(`archived-${index}`, { branch: "old", worktreePath: `/archived-${index}`, updatedAt: "2026-10-01T00:00:00Z" }));
  const h = harness({ archived, active: [thread("active", { branch: "old", worktreePath: "/active", updatedAt: "2026-10-12T00:00:00Z" })],
    rpc: frame => frame.tag === "vcs.listRefs" ? refs(frame.payload.cwd === "/active" ? "feature/work" : "main", frame.payload.cwd === "/active") : undefined });
  const result = await h.api.handle({ type: "branchLookup", repository: "owner/repo", branch: "feature/work" });
  assert.deepEqual(result.threads.map(item => [item.id, item.matchType]), [["active", "checkout"]]);
  assert.equal(h.frames.filter(frame => frame.tag === "vcs.listRefs")[0].payload.cwd, "/active");
  assert.match(result.lookupWarnings[0], /first 12 workspaces/);
  const detached = harness({ active: [thread("t")], rpc: frame => frame.tag === "vcs.listRefs" ? refs("main", false) : undefined });
  const checkout = await detached.api.handle({ type: "checkoutLookup", environmentId: "env", threadId: "t" });
  assert.deepEqual(checkout.threads[0].checkout, { state: "detached" });
});

test("calls on a closed socket fail at once instead of waiting for their own timeout", async () => {
  class Socket {
    constructor() { queueMicrotask(() => this.onopen()); }
    send() {}
    close() { this.onclose?.(); }
  }
  const client = await openRpc(Socket, "ws://localhost/ws", 30);
  await assert.rejects(client.call("slow", {}), /timed out/);
  const started = Date.now();
  await assert.rejects(client.call("next", {}), /closed/);
  assert.ok(Date.now() - started < 20);
});

test("checkout checks and connection status skip unrelated snapshot downloads", async () => {
  const remote = { ...connection, id: "remote", name: "Remote", endpoint: "https://remote.test", environmentId: "remote-env" };
  const h = harness({ saved: [connection, remote], active: [thread("t")],
    http: (path, _, url) => path === "/.well-known/t3/environment" && url.startsWith("https://remote.test") ? { ok: true, async json() { return { ...descriptor, environmentId: "remote-env" }; } } : undefined });
  const checkout = await h.api.handle({ type: "checkoutLookup", environmentId: "env", threadId: "t" });
  assert.equal(checkout.threads[0].checkout.state, "branch");
  assert.equal(h.requests.some(item => item.url.startsWith("https://remote.test")), false);
  h.requests.length = 0;
  h.frames.length = 0;
  const status = await h.api.handle({ type: "status" });
  assert.equal(status.ok, true);
  assert.deepEqual(status.environments.map(item => item.ok), [true, true]);
  assert.equal(h.requests.some(item => item.url.endsWith("/api/orchestration/shell")), false);
  assert.equal(h.frames.length, 0);
  assert.ok(h.requests.filter(item => item.url.endsWith("/api/auth/websocket-ticket")).every(item => item.options.headers.Authorization));
});

test("server labels get display-name checks and an environment can only be saved once", async () => {
  for (const [label, expected] of [["all", "localhost:7940"], ["Mac\nMini", "Mac Mini"]]) {
    const h = harness({ saved: [], http: path => path === "/.well-known/t3/environment" ? { ok: true, async json() { return { ...descriptor, label }; } } : undefined });
    const result = await h.api.handle({ type: "saveConfig", config: { endpoint: "http://localhost:7940", pairingCode: "code" } });
    assert.equal(result.connection.name, expected);
  }
  const h = harness();
  const sameEnvironment = await h.api.handle({ type: "saveConfig", config: { endpoint: "https://mini.tailnet.test", pairingCode: "code", name: "Again" } });
  assert.match(sameEnvironment.error, /already saved as This computer/);
  assert.equal(h.data.t3Connections.length, 1);
  assert.equal(h.requests.some(item => item.url.endsWith("/oauth/token")), false);
});

test("removing or moving a connection releases its site only when no other connection uses it", async () => {
  const proxied = { ...connection, id: "proxied", name: "Proxied", endpoint: "http://127.0.0.1:3773/other", environmentId: "other-env" };
  const h = harness({ saved: [connection, proxied] });
  await h.api.handle({ type: "removeConnection", id: "proxied" });
  assert.deepEqual(h.removedOrigins, []);
  await h.api.handle({ type: "saveConfig", config: { id: "local", endpoint: "https://moved.test", pairingCode: "code" } });
  assert.deepEqual(h.removedOrigins, ["http://127.0.0.1:3773/*"]);
  await h.api.handle({ type: "removeConnection", id: "local" });
  assert.deepEqual(h.removedOrigins, ["http://127.0.0.1:3773/*", "https://moved.test/*"]);
});
