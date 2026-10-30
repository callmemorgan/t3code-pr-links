const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const extension = path.join(__dirname, "../extension");
const tick = () => new Promise(resolve => setImmediate(resolve));
const thread = { id: "t1", environmentId: "mini", title: "Thread one", computer: "Mac Mini", matchType: "linked", archived: false };
function list(t, sendMessage, runtime = {}) {
  const dom = new JSDOM('<main><ul aria-label="Pull requests"><li><h3><a href="/owner/repo/pull/42">PR 42</a></h3></li><li><h3><a href="/owner/repo/pull/43">PR 43</a></h3></li></ul></main>', {
    url: "https://github.com/owner/repo/pulls", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  dom.window.chrome = { runtime: { ...runtime, sendMessage: message => message.type === "badge" ? Promise.resolve({ ok: true }) : message.type === "getPreferences" ? Promise.resolve({ ok: true, preferences: {} }) : message.type === "updatePreferences" ? Promise.resolve({ ok: true, preferences: message.patch }) : sendMessage(message) } };
  for (const file of ["common.js", "ui.js", "settings.js", "badge.js", "list.js"]) dom.window.eval(fs.readFileSync(path.join(extension, file), "utf8"));
  return dom;
}

test("PR list batches lookup and adds a direct thread link only beside matching titles", async t => {
  const requests = [];
  const dom = list(t, async message => { requests.push(message); return { ok: true, matches: { "owner/repo#42": [{ ...thread, branch: "private/branch" }], "owner/repo#43": [] } }; });
  await tick();
  const badges = dom.window.document.querySelectorAll(".t3code-pr-list-badge");
  assert.equal(dom.window.document.querySelector("main").outerHTML.includes("private/branch"), false);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].href, "t3code://threads/mini/t1");
  assert.equal(badges[0].previousElementSibling.textContent, "PR 42");
  assert.equal(requests[0].type, "batchLookup");
  assert.equal(requests[0].urls.length, 2);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(requests.length, 1);
  assert.equal(dom.window.document.querySelector(".t3code-pr-list-badge"), badges[0]);
});

test("multiple threads are individually accessible in a PR list menu", async t => {
  const dom = list(t, async () => ({ ok: true, matches: { "owner/repo#42": [thread, { ...thread, id: "t2", title: "Second thread" }] } }));
  await tick();
  const badge = dom.window.document.querySelector("details.t3code-pr-list-badge");
  badge.querySelector("summary").click();
  assert.equal(badge.open, true);
  assert.equal(badge.querySelectorAll("a").length, 2);
  assert.ok(badge.querySelector('a[href="t3code://threads/mini/t2"]'));
});

test("a PR list menu closes on an outside click or Escape", async t => {
  const dom = list(t, async () => ({ ok: true, matches: { "owner/repo#42": [thread, { ...thread, id: "t2", title: "Second thread" }] } }));
  await tick();
  const { document, MouseEvent, KeyboardEvent } = dom.window;
  const badge = document.querySelector("details.t3code-pr-list-badge");
  badge.open = true;
  badge.querySelector(".t3code-pr-list-menu").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(badge.open, true);
  document.querySelector("main").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(badge.open, false);
  badge.open = true;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(badge.open, false);
});

test("old batch results cannot add badges after navigation to a PR detail page", async t => {
  let resolve;
  const dom = list(t, () => new Promise(done => { resolve = done; }));
  await tick();
  dom.window.history.pushState({}, "", "/owner/repo/pull/42");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  resolve({ ok: true, matches: { "owner/repo#42": [thread] } });
  await tick();
  assert.equal(dom.window.document.querySelector(".t3code-pr-list-badge"), null);
});

test("disabling list badges removes them immediately and re-enabling reuses cached matches", async t => {
  let calls = 0;
  const dom = list(t, async () => { calls++; return { ok: true, matches: { "owner/repo#42": [thread] } }; });
  await tick();
  await dom.window.T3Settings.update({ listBadges: false });
  await tick();
  assert.equal(dom.window.document.querySelector(".t3code-pr-list-badge"), null);
  await dom.window.T3Settings.update({ listBadges: true });
  await tick();
  assert.ok(dom.window.document.querySelector(".t3code-pr-list-badge"));
  assert.equal(calls, 1);
});

test("popup list context shares the pending batch and rejects non-popup senders", async t => {
  let handler;
  let resolve;
  let calls = 0;
  const dom = list(t, () => { calls++; return new Promise(done => { resolve = done; }); }, {
    id: "test-id", getURL: p => `chrome-extension://test-id/${p}`, onMessage: { addListener(fn) { handler = fn; } },
  });
  await tick();
  assert.equal(handler({ type: "listContext" }, { id: "test-id", url: "https://github.com" }, () => {}), false);
  const context = new Promise(done => handler({ type: "listContext", force: true }, { id: "test-id", url: "chrome-extension://test-id/popup.html" }, done));
  resolve({ ok: true, matches: { "owner/repo#42": [thread] } });
  const response = await context;
  assert.equal(calls, 1);
  assert.equal(response.pullRequests.length, 1);
  assert.equal(response.pullRequests[0].number, 42);
  assert.equal(response.pullRequests[0].threads[0].id, "t1");
});

test("replaced rows immediately before a batch reply trigger a fresh lookup", async t => {
  const pending = [];
  const dom = list(t, message => new Promise(resolve => pending.push({ message, resolve })));
  await tick();
  dom.window.document.querySelector("h3 a").href = "/owner/repo/pull/44";
  pending[0].resolve({ ok: true, matches: { "owner/repo#42": [thread] } });
  await tick();
  assert.equal(dom.window.document.querySelector(".t3code-pr-list-badge"), null);
  assert.equal(pending.length, 2);
  pending[1].resolve({ ok: true, matches: { "owner/repo#44": [thread] } });
  await tick();
  assert.equal(dom.window.document.querySelector(".t3code-pr-list-badge").previousElementSibling.href, "https://github.com/owner/repo/pull/44");
});

test("returning to an old PR list reuses its batch until popup Refresh or the visible PRs change", async t => {
  let handler, calls = 0;
  const dom = list(t, async () => { calls++; return { ok: true, matches: { "owner/repo#42": [thread] } }; }, {
    id: "test-id", getURL: p => `chrome-extension://test-id/${p}`, onMessage: { addListener(fn) { handler = fn; } },
  });
  await tick();
  dom.window.Date.now = () => Date.now() + 300000;
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await tick();
  assert.equal(calls, 1);
  await new Promise(done => handler({ type: "listContext", force: true }, { id: "test-id", url: "chrome-extension://test-id/popup.html" }, done));
  assert.equal(calls, 2);
  dom.window.document.querySelector("h3 a").href = "/owner/repo/pull/44";
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(calls, 3);
});

test("duplicate rows use canonical PR queries and produce one popup group per PR", async t => {
  let handler;
  const requests = [];
  const dom = list(t, async message => { requests.push(message); return { ok: true, matches: { "owner/repo#42": [thread] } }; }, {
    id: "test-id", getURL: p => `chrome-extension://test-id/${p}`, onMessage: { addListener(fn) { handler = fn; } },
  });
  dom.window.document.querySelector("ul").insertAdjacentHTML("beforeend", '<li><h3><a href="/Owner/Repo/pull/42/files">Duplicate PR</a></h3></li>');
  await tick();
  assert.equal(requests[0].urls.length, 2);
  assert.deepEqual(Array.from(requests[0].urls), ["https://github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/43"]);
  const context = await new Promise(done => handler({ type: "listContext" }, { id: "test-id", url: "chrome-extension://test-id/popup.html" }, done));
  assert.equal(context.pullRequests.length, 1);
  assert.equal(dom.window.document.querySelectorAll(".t3code-pr-list-badge").length, 2);
  assert.equal(requests.length, 1);
});

test("lists beyond 100 rows report incomplete coverage and flag the toolbar", async t => {
  let handler;
  const badges = [];
  const dom = list(t, async message => ({ ok: true, matches: {} }), {
    id: "test-id", getURL: p => `chrome-extension://test-id/${p}`, onMessage: { addListener(fn) { handler = fn; } },
  });
  const originalSend = dom.window.chrome.runtime.sendMessage;
  dom.window.chrome.runtime.sendMessage = message => { if (message.type === "badge") badges.push(message); return originalSend(message); };
  dom.window.document.querySelector("ul").insertAdjacentHTML("beforeend", Array.from({length:99}, (_, index) => `<li><h3><a href="/owner/repo/pull/${index + 44}">PR ${index + 44}</a></h3></li>`).join(""));
  await tick();
  const context = await new Promise(done => handler({ type: "listContext" }, { id: "test-id", url: "chrome-extension://test-id/popup.html" }, done));
  assert.equal(context.result.truncated, true);
  assert.ok(context.result.lookupWarnings[0].includes("first 100 PR rows"));
  assert.equal(badges.at(-1).problem, true);
});
