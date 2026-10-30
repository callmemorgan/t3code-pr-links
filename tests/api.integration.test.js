const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { create } = require("../extension/api.js");

// A real HTTP/WebSocket transport backed by the same Effect 4 RPC encoder and
// server used by T3. All state is synthetic; no T3 process or user data is used.
test("pairs and reads active/archived threads over HTTP and the real Effect RPC protocol", async t => {
  const [Effect, Rpc, RpcGroup, RpcServer, RpcSerialization, Schema, Queue, Option, Fiber] = await Promise.all([
    import("effect/Effect"), import("effect/rpc/Rpc"), import("effect/rpc/RpcGroup"), import("effect/rpc/RpcServer"),
    import("effect/rpc/RpcSerialization"), import("effect/Schema"), import("effect/Queue"), import("effect/Option"), import("effect/Fiber"),
  ]);
  const linked = { host: "github.com", repository: "owner/repo", number: 42, source: "manual" };
  const project = { id: "project", title: "Synthetic project", workspaceRoot: "/synthetic", repositoryIdentity: { canonicalKey: "github.com/owner/repo" } };
  const archived = { projects: [project], threads: [{ id: "archived-thread", projectId: "project", title: "Archived work", branch: "feature", pullRequests: [linked] }] };
  const group = RpcGroup.make(
    Rpc.make("orchestration.getArchivedShellSnapshot", { payload: Schema.Struct({}), success: Schema.Struct({ projects: Schema.Array(Schema.Unknown), threads: Schema.Array(Schema.Unknown) }) }),
    // Mirrors the fields of T3's VcsListRefsInput and VcsListRefsResult that the extension uses.
    Rpc.make("vcs.listRefs", {
      payload: Schema.Struct({ cwd: Schema.String, refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])), refresh: Schema.optional(Schema.Boolean), limit: Schema.optional(Schema.Number) }),
      success: Schema.Struct({ isRepo: Schema.Boolean, refs: Schema.Array(Schema.Struct({ name: Schema.String, current: Schema.Boolean, isDefault: Schema.Boolean, worktreePath: Schema.NullOr(Schema.String) })) }),
    }),
  );
  const layer = group.toLayer({
    "orchestration.getArchivedShellSnapshot": () => Effect.succeed(archived),
    "vcs.listRefs": input => {
      assert.deepEqual(input, { cwd: "/synthetic", refKind: "local", refresh: true, limit: 1 });
      return Effect.succeed({ isRepo: true, refs: [{ name: "feature", current: true, isDefault: false, worktreePath: "/synthetic" }] });
    },
  });
  let receive, disconnect;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const clients = new Map();
  const runtime = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    const disconnects = yield* Queue.unbounded();
    disconnect = id => Effect.runPromise(Queue.offer(disconnects, id));
    const protocol = yield* RpcServer.Protocol.make(write => {
      receive = write;
      resolveReady();
      return Effect.succeed({
        disconnects,
        send: (id, response) => Effect.sync(() => clients.get(id)?.send(JSON.stringify(response))),
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set(clients.keys())),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true, supportsTransferables: false, supportsSpanPropagation: true, supportsNotifications: true,
        codecFor: RpcSerialization.json.codecFor,
      });
    });
    yield* RpcServer.make(group).pipe(Effect.provideService(RpcServer.Protocol, protocol), Effect.provide(layer));
  })));
  t.after(async () => { await Effect.runPromise(Fiber.interrupt(runtime)); });
  await ready;
  const state = { t3Connections: [] };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/t3/environment") {
      res.end(JSON.stringify({ environmentId: "synthetic-env", label: "Synthetic T3", serverVersion: "0.0.45", orchestrationProtocolVersion: 2 }));
    } else if (req.url === "/oauth/token") {
      assert.equal(new URLSearchParams(body).get("subject_token"), "synthetic-pairing-code");
      assert.equal(new URLSearchParams(body).get("scope"), "orchestration:read");
      res.end(JSON.stringify({ access_token: "synthetic-access-token", token_type: "Bearer", scope: "orchestration:read", expires_in: 3600 }));
    } else {
      assert.equal(req.headers.authorization, "Bearer synthetic-access-token");
      if (req.url === "/api/auth/websocket-ticket") res.end(JSON.stringify({ ticket: "synthetic-ticket" }));
      else if (req.url === "/api/orchestration/shell") {
        assert.equal(req.headers["x-t3-orchestration-protocol"], "2");
        res.end(JSON.stringify({ projects: [project], threads: [{ id: "active-thread", projectId: "project", title: "Active work", branch: "feature", pullRequests: [linked] }], archivedThreads: [] }));
      } else { res.statusCode = 404; res.end("{}"); }
    }
  });
  const wss = new WebSocketServer({ server });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  let nextClient = 0;
  wss.on("connection", (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    assert.equal(url.pathname, "/ws");
    assert.equal(url.searchParams.get("wsTicket"), "synthetic-ticket");
    assert.equal(url.searchParams.get("orchestrationProtocol"), "2");
    const id = ++nextClient;
    clients.set(id, socket);
    socket.on("message", data => { void Effect.runPromise(receive(id, JSON.parse(data.toString()))); });
    socket.on("close", () => { clients.delete(id); void disconnect(id); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const chrome = { storage: { local: {
    async setAccessLevel() {}, async get(key) { return { [key]: state[key] }; }, async set(data) { Object.assign(state, data); },
  } }, permissions: { async contains() { return true; } } };
  const api = create({ chrome, fetch, WebSocket, timeout: 2000 });
  const paired = await api.handle({ type: "saveConfig", config: { endpoint, pairingCode: "synthetic-pairing-code" } });
  assert.equal(paired.ok, true, paired.error);
  assert.equal(paired.warning, undefined);
  const result = await api.handle({ type: "lookup", repository: "owner/repo", number: 42 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.threads.map(thread => [thread.id, thread.archived]), [["active-thread", false], ["archived-thread", true]]);
  const checkout = await api.handle({ type: "checkoutLookup", environmentId: "synthetic-env", threadId: "active-thread" });
  assert.equal(checkout.threads[0].checkout.branch, "feature");
  assert.ok(requests.includes("/api/orchestration/shell"));
});
