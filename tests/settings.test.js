const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../extension/settings.js"), "utf8");

test("GitHub preferences use the background proxy and reject spoofed preference notifications", async () => {
  let onMessage;
  const requests = [];
  const context = { location: { protocol: "https:" }, chrome: { runtime: {
    id: "extension-id", onMessage: { addListener(fn) { onMessage = fn; } },
    async sendMessage(message) {
      requests.push(message);
      return { ok: true, preferences: message.patch || { includeArchived: false } };
    },
  }, storage: { local: {
    get() { throw Error("Content scripts must not read credential storage"); },
    set() { throw Error("Content scripts must not write credential storage"); },
  } } } };
  vm.runInNewContext(source, context);
  await context.T3Settings.ready;
  assert.equal(context.T3Settings.get().includeArchived, false);
  await context.T3Settings.update({ includeBranch: false });
  assert.deepEqual(requests.map(message => message.type), ["getPreferences", "updatePreferences"]);
  onMessage({ type: "preferencesChanged", preferences: {} }, { id: "wrong-id" });
  assert.equal(context.T3Settings.get().includeBranch, false);
  onMessage({ type: "preferencesChanged", preferences: {} }, { id: "extension-id", tab: {} });
  assert.equal(context.T3Settings.get().includeBranch, false);
  onMessage({ type: "preferencesChanged", preferences: {} }, { id: "extension-id" });
  assert.equal(context.T3Settings.get().includeBranch, true);
});

test("saved preferences filter by archive, match kind, and computer and follow local changes", async () => {
  let onChanged;
  const writes = [];
  const context = { chrome: { storage: {
    local: { async get() { return { preferences: { includeArchived: false, includeBranch: false, computer: "Mac Mini" } }; },
      async set(value) { writes.push(value); } },
    onChanged: { addListener(fn) { onChanged = fn; } },
  } } };
  vm.runInNewContext(source, context);
  const settings = context.T3Settings;
  await settings.ready;
  const records = [{ id: "right", computer: "Mac Mini", matchType: "linked" },
    { id: "archived", computer: "Mac Mini", archived: true },
    { id: "branch", computer: "Mac Mini", matchType: "branch" }, { id: "local" }];
  assert.deepEqual(Array.from(settings.filter(records), thread => thread.id), ["right"]);
  assert.equal(settings.filter([{ computer: "Mac Mini", matchType: "checkout" }]).length, 0);
  await settings.update({ computer: "all", includeBranch: true });
  assert.equal(writes[0].preferences.includeArchived, false);
  assert.equal(settings.filter(records).length, 3);
  onChanged({ preferences: { newValue: {} } }, "sync");
  assert.equal(settings.filter(records).length, 3);
  onChanged({ preferences: { newValue: {} } }, "local");
  assert.equal(settings.filter(records).length, 4);
});

test("failed preference writes do not silently change the current filters", async () => {
  const context = { chrome: { storage: { local: { async get() { return {}; }, async set() { throw Error("Storage unavailable"); } } } } };
  vm.runInNewContext(source, context);
  await assert.rejects(context.T3Settings.update({ includeArchived: false }));
  assert.equal(context.T3Settings.get().includeArchived, true);
});

test("thread sorting is stable, preserves explicit PR priority, and does not mutate responses", async () => {
  const context = {};
  vm.runInNewContext(source, context);
  const settings = context.T3Settings;
  const records = [
    { id: "workspace", title: "A workspace", matchType: "checkout", updatedAt: "2026-10-13" },
    { id: "linked", title: "Z linked", matchType: "linked", updatedAt: "2026-10-11" },
    { id: "archived", title: "B archived", matchType: "linked", archived: true, updatedAt: "2026-10-12" },
  ];
  assert.deepEqual(Array.from(settings.sort(records), t => t.id), ["linked", "archived", "workspace"]);
  await settings.update({ sort: "recent" });
  assert.deepEqual(Array.from(settings.sort(records, { repository: true }), t => t.id), ["workspace", "archived", "linked"]);
  await settings.update({ sort: "title" });
  assert.deepEqual(Array.from(settings.sort(records, { repository: true }), t => t.id), ["workspace", "archived", "linked"]);
  assert.equal(records[0].id, "workspace");
});

test("updates send only changed keys and merge with the latest stored preferences in order", async () => {
  const requests = [];
  const content = { location: { protocol: "https:" }, chrome: { runtime: { id: "extension-id", onMessage: { addListener() {} },
    async sendMessage(message) { requests.push(message); return { ok: true, preferences: { sort: "title", ...message.patch } }; } } } };
  vm.runInNewContext(source, content);
  await content.T3Settings.update({ includeArchived: false, unknown: true });
  assert.deepEqual({ ...requests.at(-1).patch }, { includeArchived: false });
  assert.equal(content.T3Settings.get().sort, "title");

  let stored = { sort: "title" };
  const page = { chrome: { storage: { local: {
    async get() { await new Promise(resolve => setTimeout(resolve, 5)); return { preferences: stored }; },
    async set(value) { stored = value.preferences; },
  } } } };
  vm.runInNewContext(source, page);
  await page.T3Settings.ready;
  stored = { ...stored, liveBranches: false };
  await Promise.all([page.T3Settings.update({ includeArchived: false }), page.T3Settings.update({ includeBranch: false })]);
  assert.deepEqual([stored.sort, stored.liveBranches, stored.includeArchived, stored.includeBranch], ["title", false, false, false]);
});
