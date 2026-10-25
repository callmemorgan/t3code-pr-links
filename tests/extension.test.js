const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { parsePullRequest, threadUrl, headBranch } = require("../extension/common.js");
const extension = path.join(__dirname, "../extension");

test("matches exact repository and number on all PR tabs", () => {
  for (const suffix of ["", "/", "/files", "/commits", "/checks?check_run_id=1#details"]) {
    assert.equal(parsePullRequest(`https://github.com/Owner/Repo/pull/42${suffix}`).key, "owner/repo#42");
  }
  for (const url of ["https://evil.test/owner/repo/pull/42", "https://github.com/owner/repo/issues/42", "https://github.com/owner/repo/pulls", "https://github.com/owner/repo/pull/0", "https://github.com/owner/repo/pull/42fake", "http://github.com/owner/repo/pull/42", "https://github.com:4430/owner/repo/pull/42"]) {
    assert.equal(parsePullRequest(url), null);
  }
  assert.equal(threadUrl("env/a", "thread?prompt=evil"), "t3code://threads/env%2Fa/thread%3Fprompt%3Devil");
});

function fixture(t, sendMessage, html = '<main><div id="partial-discussion-header"><h1>PR title</h1></div></main>', runtime = {}) {
  const dom = new JSDOM(html, {
    url: "https://github.com/owner/repo/pull/42", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.document, "hidden", { get: () => false });
  dom.window.chrome = { runtime: { ...runtime, sendMessage: message => message.type === "badge" ? Promise.resolve({ ok: true }) : message.type === "getPreferences" ? Promise.resolve({ ok: true, preferences: {} }) : message.type === "updatePreferences" ? Promise.resolve({ ok: true, preferences: message.patch }) : sendMessage(message) } };
  dom.window.eval(fs.readFileSync(path.join(extension, "common.js"), "utf8"));
  dom.window.eval(fs.readFileSync(path.join(extension, "ui.js"), "utf8"));
  dom.window.eval(fs.readFileSync(path.join(extension, "settings.js"), "utf8"));
  dom.window.eval(fs.readFileSync(path.join(extension, "badge.js"), "utf8"));
  dom.window.eval(fs.readFileSync(path.join(extension, "content.js"), "utf8"));
  return dom;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = { ok: true, threads: [{ id: "thread-1", environmentId: "env-1", title: '<img src=x onerror="alert(1)">' }] };

test("adds a native link and treats thread titles as text", async t => {
  const dom = fixture(t, async () => response);
  await tick();
  const panel = dom.window.document.getElementById("t3code-pr-links");
  assert.equal(panel.previousElementSibling.id, "partial-discussion-header");
  assert.equal(panel.querySelector("a").getAttribute("href"), "t3code://threads/env-1/thread-1");
  assert.equal(panel.querySelector("img"), null);
  assert.ok(panel.textContent.includes(response.threads[0].title));
  const link = panel.querySelector("a");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(dom.window.document.querySelector("#t3code-pr-links a"), link);
});

test("shows all matched threads and stays quiet on unmatched PRs", async t => {
  let data = { ok: true, threads: [...response.threads, { id: "second", environmentId: "env-2", title: "Second thread" }] };
  const dom = fixture(t, async () => data);
  await tick();
  assert.equal(dom.window.document.querySelectorAll("#t3code-pr-links a").length, 2);
  data = { ok: true, threads: [] };
  dom.window.document.querySelector('[data-action="refresh"]').click();
  await tick();
  assert.equal(dom.window.document.getElementById("t3code-pr-links"), null);
});

test("remote match opens its own environment and identifies its computer", async t => {
  const dom = fixture(t, async () => ({ ok: true, threads: [{ id: "mini-thread", environmentId: "mini-env", title: "Mini work", computer: "Mac Mini" }] }));
  await tick();
  assert.equal(dom.window.document.querySelector("#t3code-pr-links a").getAttribute("href"), "t3code://threads/mini-env/mini-thread");
  assert.ok(dom.window.document.getElementById("t3code-pr-links").textContent.includes("Mac Mini"));
});

test("renders in GitHub's React PR header and ignores dialog headings and sticky duplicates", async t => {
  const dom = fixture(t, async () => response, `
    <dialog><h1>Command palette</h1></dialog>
    <main><div data-component="PageHeader" data-has-nav>
      <div data-component="TitleArea"><h1 data-component="PH_Title">PR title</h1></div>
      <nav aria-label="Pull request navigation">Conversation</nav>
    </div><div data-component="PageHeader"><h2>Sticky PR title</h2></div></main>
  `);
  await tick();
  const panel = dom.window.document.getElementById("t3code-pr-links");
  assert.ok(panel);
  assert.ok(panel.previousElementSibling.hasAttribute("data-has-nav"));
  assert.equal(panel.closest("dialog"), null);
});

test("supports a PageHeader without a navigation marker", async t => {
  const dom = fixture(t, async () => response, '<main><div data-component="PageHeader"><h1 data-component="PH_Title">PR title</h1></div></main>');
  await tick();
  assert.ok(dom.window.document.querySelector("#t3code-pr-links a"));
});

test("PR branch lookup reads the head repository including forks and excludes comment links", async t => {
  let query;
  const dom = fixture(t, async message => { query = message; return { ok: true, threads: [{ ...response.threads[0], matchType: "branch", branch: "Feature/foo" }] }; }, `
    <main><div data-component="PageHeader" data-has-nav>
      <h1 data-component="PH_Title">PR title</h1>
      <a data-component="BranchName" href="/owner/repo/tree/main">main</a>
      <a data-component="BranchName" href="/fork/repo/tree/Feature%2Ffoo">Feature/foo</a>
    </div><article><a href="/wrong/repo/tree/not-the-branch">Misleading comment</a></article></main>`);
  await tick();
  assert.equal(query.head.repository, "fork/repo");
  assert.equal(query.head.branch, "Feature/foo");
  assert.ok(dom.window.document.getElementById("t3code-pr-links").textContent.includes("Branch match"));
  assert.equal(headBranch(new JSDOM('<article><a href="/owner/repo/tree/main">main</a></article>').window.document), null);
});

test("manual refresh recovers from an offline computer", async t => {
  let calls = 0;
  let data = { ...response, environments: [{ name: "Mac Mini", ok: false, error: "Offline" }] };
  const dom = fixture(t, async () => { calls++; return data; });
  await tick();
  const document = dom.window.document;
  assert.ok(document.querySelector("#t3code-pr-links").textContent.includes("Could not check: Mac Mini"));
  data = { ...response, environments: [{ name: "Mac Mini", ok: true }] };
  document.querySelector('[data-action="refresh"]').click();
  await tick();
  assert.equal(calls, 2);
  assert.equal(document.querySelector(".t3code-pr-warning"), null);
});

test("connection errors remain visible even without matching threads", async t => {
  const dom = fixture(t, async () => ({ ok: false, error: "Local helper unavailable" }));
  await tick();
  assert.ok(dom.window.document.getElementById("t3code-pr-links").textContent.includes("Local helper unavailable"));
  assert.ok(dom.window.document.querySelector('[data-action="refresh"]'));
});

test("popup context waits for an existing lookup and rejects non-popup senders", async t => {
  let handler;
  let resolve;
  let calls = 0;
  const dom = fixture(t, () => { calls++; return new Promise(done => { resolve = done; }); }, undefined, {
    id: "test-id", getURL: p => `chrome-extension://test-id/${p}`,
    onMessage: { addListener(listener) { handler = listener; } },
  });
  await tick();
  assert.equal(handler({ type: "pageContext" }, { id: "test-id", url: "https://github.com" }, () => {}), false);
  const reply = new Promise(done => {
    assert.equal(handler({ type: "pageContext", force: true }, { id: "test-id", url: "chrome-extension://test-id/popup.html" }, done), true);
  });
  resolve(response);
  const context = await reply;
  assert.equal(context.pr.number, 42);
  assert.equal(context.result.threads[0].id, "thread-1");
  assert.equal(calls, 1);
});

test("drops stale responses after GitHub navigates to a different PR", async t => {
  const pending = [];
  const dom = fixture(t, message => new Promise(resolve => pending.push({ message, resolve })));
  await tick();
  assert.equal(pending.length, 1);
  dom.window.history.pushState({}, "", "/other/repo/pull/99/files");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(pending.length, 2);
  pending[0].resolve(response);
  await tick();
  assert.equal(dom.window.document.getElementById("t3code-pr-links"), null);
  pending[1].resolve({ ok: true, threads: [{ id: "other", environmentId: "env-1", title: "Other PR" }] });
  await tick();
  assert.equal(dom.window.document.querySelector("#t3code-pr-links a").getAttribute("href"), "t3code://threads/env-1/other");
  dom.window.history.pushState({}, "", "/other/repo/issues/99");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(dom.window.document.getElementById("t3code-pr-links"), null);
});

test("restores panel when GitHub replaces its header without refetching", async t => {
  let calls = 0;
  const dom = fixture(t, async () => { calls++; return response; });
  await tick();
  dom.window.document.querySelector("main").innerHTML = '<div class="gh-header">Replacement header</div>';
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(dom.window.document.querySelector("#t3code-pr-links a"));
  assert.equal(calls, 1);
});

test("navigation immediately before a reply cannot render the previous PR's links", async t => {
  const pending = [];
  const dom = fixture(t, () => new Promise(resolve => pending.push(resolve)));
  await tick();
  dom.window.history.pushState({}, "", "/owner/repo/pull/43");
  pending[0](response);
  await tick();
  assert.equal(dom.window.document.getElementById("t3code-pr-links"), null);
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, threads: [] });
  await tick();
});

test("background only permits matching GitHub lookups and popup diagnostics", async () => {
  const vm = require("node:vm");
  let handler;
  const calls = [];
  const context = {
    URL, T3Pr: { parsePullRequest }, fetch() {}, WebSocket() {}, importScripts() {},
    T3Api: { create() { return { storageReady: Promise.resolve(), async handle(request) { calls.push({ request }); return { ok: true, threads: [] }; } }; } },
    chrome: { storage: { onChanged: { addListener() {} } }, runtime: {
      id: "test-id", getURL: p => `chrome-extension://test-id/${p}`,
      onInstalled: { addListener() {} }, onMessage: { addListener(fn) { handler = fn; } },
    } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
  const sender = { id: "test-id", tab: { url: "https://github.com/owner/repo/pull/42" } };
  const answers = [];
  assert.equal(handler({ type: "lookup", url: sender.tab.url }, sender, r => answers.push(r)), true);
  await tick();
  assert.equal(calls[0].request.repository, "owner/repo");
  assert.equal(answers[0].ok, true);
  handler({ type: "lookup", url: "https://github.com/other/repo/pull/42" }, sender, r => answers.push(r));
  handler({ type: "status" }, sender, () => {});
  handler({ type: "lookup", url: sender.tab.url }, { ...sender, id: "other-id" }, () => {});
  assert.equal(calls.length, 1);
  handler({ type: "status" }, { id: "test-id", url: "chrome-extension://test-id/popup.html" }, () => {});
  await tick();
  assert.equal(calls.length, 2);
});

const branchHeader = branch => `<main><button data-icv-name="Switch branches/tags" aria-label="${branch} branch"><svg class="octicon-git-branch"></svg>${branch}</button><h2>Folders and files</h2></main>`;

test("branch pages use the selected branch rather than the file path, and exclude tags/commits", () => {
  const { branchPage } = require("../extension/common.js");
  const dom = new JSDOM(branchHeader("Feature/foo"));
  for (const path of ["/owner/repo", "/owner/repo/tree/Feature/foo", "/owner/repo/tree/Feature%2Ffoo/docs", "/owner/repo/blob/Feature/foo/src/app.js"]) {
    assert.equal(branchPage(dom.window.document, `https://github.com${path}`).branch, "Feature/foo");
  }
  assert.equal(branchPage(dom.window.document, "https://github.com/owner/repo/tree/other"), null);
  assert.equal(branchPage(dom.window.document, "https://github.com/owner/repo/commits/Feature/foo"), null);
  dom.window.document.querySelector("svg").className.baseVal = "octicon-tag";
  assert.equal(branchPage(dom.window.document, "https://github.com/owner/repo/tree/Feature/foo"), null);
  dom.window.close();
});

test("navigating from a PR to a branch replaces the context and requests a branch lookup", async t => {
  const requests = [];
  const dom = fixture(t, async message => { requests.push(message); return response; });
  await tick();
  dom.window.history.pushState({}, "", "/owner/repo/tree/Feature/foo/src");
  dom.window.document.body.innerHTML = branchHeader("Feature/foo");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(requests.at(-1).type, "branchLookup");
  assert.equal(requests.at(-1).branch, "Feature/foo");
  assert.equal(dom.window.document.querySelector("main").firstElementChild.id, "t3code-pr-links");
});

test("branch hydration immediately before a PR reply discards old branch matches", async t => {
  const pending = [];
  const dom = fixture(t, message => new Promise(resolve => pending.push({ message, resolve })), `
    <main><div class="gh-header"><a class="commit-ref" href="/owner/repo/tree/main">main</a><a class="commit-ref" href="/owner/repo/tree/old">old</a></div></main>`);
  await tick();
  dom.window.document.querySelectorAll(".commit-ref")[1].href = "/owner/repo/tree/new";
  pending[0].resolve(response);
  await tick();
  assert.equal(dom.window.document.querySelector("#t3code-pr-links"), null);
  assert.equal(pending[1].message.head.branch, "new");
  pending[1].resolve({ ok: true, threads: [] });
  await tick();
});

test("filtered PR matches remain discoverable and can be restored without another lookup", async t => {
  let calls = 0;
  const dom = fixture(t, async () => { calls++; return { ok: true, threads: [{ ...response.threads[0], archived: true }] }; });
  await tick();
  await dom.window.T3Settings.update({ includeArchived: false });
  const document = dom.window.document;
  assert.equal(document.querySelector("#t3code-pr-links a"), null);
  assert.ok(document.querySelector(".t3code-pr-filter-notice").textContent.includes("1 thread hidden"));
  document.querySelector(".t3code-pr-filter-notice button").click();
  await tick();
  assert.ok(document.querySelector("#t3code-pr-links a"));
  assert.equal(calls, 1);
});

test("copy links encode IDs and offer a selected field when the clipboard is unavailable", async t => {
  const dom = fixture(t, async () => ({ ok: true, threads: [{ id: "thread/one", environmentId: "env?one", title: "Copy me" }] }));
  await tick();
  const document = dom.window.document;
  document.body.append(dom.window.T3Ui.copyButton(document, { id: "thread/one", environmentId: "env?one", title: "Copy me" }));
  document.querySelector(".t3code-pr-copy button").click();
  await tick();
  const input = document.querySelector(".t3code-pr-copy-value");
  assert.equal(input.value, "t3code://threads/env%3Fone/thread%2Fone");
  assert.equal(input.readOnly, true);
  assert.equal(input.selectionEnd, input.value.length);
  const writes = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { async writeText(text) { writes.push(text); } } });
  document.querySelector(".t3code-pr-copy button").click();
  await tick();
  assert.equal(writes[0], input.value);
  assert.equal(document.querySelector(".t3code-pr-copy-value"), null);
  assert.equal(document.querySelector(".t3code-pr-copy-status").textContent, "Copied");
});

test("PR panel stays compact while associated PR links remain available to the thread browser", async t => {
  const thread = { ...response.threads[0], project: "Project", workspace: "<img src=evil>", workspaceType: "worktree",
    pullRequests: [{ repository: "Owner/Repo", number: 42 }, { repository: "evil/repo/extra", number: 4 }, { repository: "other/repo", number: 43 }] };
  const dom = fixture(t, async () => ({ ok: true, threads: [thread] }));
  await tick();
  const document = dom.window.document;
  const panel = document.getElementById("t3code-pr-links");
  assert.equal(panel.querySelector("details"), null);
  assert.equal(panel.querySelector(".t3code-pr-checkout"), null);
  assert.equal(panel.textContent.includes(thread.workspace), false);
  assert.equal(panel.textContent.includes("Project"), false);
  for (const unrendered of ["Project", "worktree", "evil/repo/extra"]) assert.equal(panel.outerHTML.includes(unrendered), false);
  document.body.append(dom.window.T3Ui.pullRequestLinks(document, thread));
  assert.equal(document.querySelectorAll(".t3code-pr-associated-prs a").length, 2);
  assert.equal(document.querySelector(".t3code-pr-associated-prs a").href, "https://github.com/owner/repo/pull/42");
  assert.equal(document.querySelector(".t3code-pr-associated-prs a").rel, "noopener");
  assert.equal(document.querySelector("#t3code-pr-links img"), null);
});

test("current checkout is queried only when clicked and reports recorded-branch differences", async t => {
  const requests = [];
  const dom = fixture(t, async message => {
    requests.push(message);
    return message.type === "checkoutLookup" ? { ok: true, threads: [{ id: "thread-1", environmentId: "env-1", checkout: { state: "branch", branch: "other", matchesRecorded: false } }] } : response;
  });
  await tick();
  assert.equal(requests.length, 1);
  dom.window.document.body.append(dom.window.T3Ui.checkoutControl(dom.window.document, response.threads[0]));
  dom.window.document.querySelector(".t3code-pr-checkout button").click();
  await tick();
  assert.equal(requests[1].type, "checkoutLookup");
  assert.equal(requests[1].threadId, "thread-1");
  assert.ok(dom.window.document.querySelector(".t3code-pr-checkout-status").textContent.includes("Differs from the recorded branch"));
});

test("live workspace preferences requery while incomplete scans remain visible without matches", async t => {
  const requests = [];
  const dom = fixture(t, async message => {
    requests.push(message);
    return { ok: true, threads: [], lookupWarnings: ["Workspace scan was incomplete"] };
  });
  await tick();
  assert.ok(dom.window.document.querySelector(".t3code-pr-warning").textContent.includes("incomplete"));
  await dom.window.T3Settings.update({ liveBranches: false });
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].liveBranches, false);
});

test("workspace matches show the observed source branch rather than a stale recorded branch", async t => {
  const dom = fixture(t, async () => ({ ok: true, threads: [{ ...response.threads[0], matchType: "checkout", branch: "old-branch", matchedBranch: "feature/current" }] }));
  await tick();
  assert.equal(dom.window.document.querySelector(".t3code-pr-source-branch").textContent, "Matching branch: feature/current");
  assert.ok(dom.window.document.querySelector(".t3code-pr-match-kind").title.includes("currently checked out"));
});

test("returning to an old PR reuses matches until manual refresh or navigation", async t => {
  let calls = 0;
  const dom = fixture(t, async () => { calls++; return response; });
  await tick();
  const now = Date.now();
  dom.window.Date.now = () => now + 300000;
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await tick();
  assert.equal(calls, 1);
  dom.window.document.querySelector('[data-action="refresh"]').click();
  await tick();
  assert.equal(calls, 2);
  dom.window.history.pushState({}, "", "/owner/repo/pull/43");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(calls, 3);
});

function recordBadges(dom) {
  const badges = [];
  const send = dom.window.chrome.runtime.sendMessage;
  dom.window.chrome.runtime.sendMessage = message => { if (message.type === "badge") badges.push(`${message.kind}:${message.count}`); return send(message); };
  return badges;
}

test("the toolbar badge counts matches even when no header anchor is found for the panel", async t => {
  const dom = fixture(t, async () => response, "<main><p>Unrecognized PR layout</p></main>");
  const badges = recordBadges(dom);
  await tick();
  assert.equal(dom.window.document.getElementById("t3code-pr-links"), null);
  assert.equal(badges.at(-1), "pr:1");
});

test("a branch picker that briefly reloads on the same URL keeps the result without a new lookup", async t => {
  const requests = [];
  const dom = fixture(t, async message => { requests.push(message); return response; }, branchHeader("feature"));
  dom.window.history.replaceState({}, "", "/owner/repo/tree/feature");
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(requests.filter(message => message.type === "branchLookup").length, 1);
  const picker = dom.window.document.querySelector("button[data-icv-name]");
  picker.dataset.loading = "true";
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.ok(dom.window.document.getElementById("t3code-pr-links"));
  delete picker.dataset.loading;
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await tick();
  assert.equal(requests.filter(message => message.type === "branchLookup").length, 1);
  assert.ok(dom.window.document.getElementById("t3code-pr-links"));
});

test("with list badges off, the PR-list script leaves the PR panel's toolbar badge alone", async t => {
  const dom = new JSDOM('<main><div id="partial-discussion-header"><h1>PR title</h1></div></main>', {
    url: "https://github.com/owner/repo/pull/42", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.document, "hidden", { get: () => false });
  const badges = [];
  dom.window.chrome = { runtime: { sendMessage: async message => {
    if (message.type === "badge") { badges.push(`${message.kind}:${message.count}`); return { ok: true }; }
    if (message.type === "getPreferences") return { ok: true, preferences: { listBadges: false } };
    return response;
  } } };
  for (const file of ["common.js", "ui.js", "settings.js", "badge.js", "content.js", "list.js"]) dom.window.eval(fs.readFileSync(path.join(extension, file), "utf8"));
  await tick();
  dom.window.document.querySelector("main").append(dom.window.document.createElement("div"));
  await new Promise(resolve => setTimeout(resolve, 150));
  await tick();
  assert.deepEqual(badges, ["pr:1"]);
});
