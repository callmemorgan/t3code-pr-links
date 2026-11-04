const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const extension = path.join(__dirname, "../extension");
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser(t, sendMessage, query = "?repository=owner%2Frepo", storage) {
  const dom = new JSDOM(fs.readFileSync(path.join(extension, "threads.html"), "utf8"), {
    url: `chrome-extension://test-id/threads.html${query}`, runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  dom.window.chrome = { runtime: { sendMessage }, storage };
  for (const file of ["common.js", "ui.js", "settings.js", "threads.js"]) dom.window.eval(fs.readFileSync(path.join(extension, file), "utf8"));
  return dom;
}

test("repository browser searches title/branch locally and exposes incomplete coverage", async t => {
  let calls = 0;
  const dom = browser(t, async request => {
    calls++; assert.equal(request.repository, "owner/repo");
    return { ok: true, truncated: true, environments: [{ name: "Mac Mini", ok: false, error: "Offline" }], threads: [
      { id: "a", environmentId: "env", title: "<script>Work</script>", branch: "Feature/foo", matchType: "repository" },
      { id: "b", environmentId: "env", title: "Other work", branch: "main", archived: true, matchType: "repository" },
    ] };
  });
  await tick();
  const document = dom.window.document;
  assert.equal(document.querySelectorAll(".thread").length, 2);
  assert.ok(document.getElementById("coverage").textContent.includes("Mac Mini: Offline"));
  assert.ok(document.getElementById("count").textContent.includes("results were limited"));
  const search = document.getElementById("search");
  search.value = "feature/FOO"; search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelectorAll(".thread").length, 1);
  assert.equal(document.querySelector(".thread a").textContent, "<script>Work</script> ↗");
  assert.equal(document.querySelector(".thread script"), null);
  search.value = ""; search.dispatchEvent(new dom.window.Event("input"));
  await dom.window.T3Settings.update({ includeArchived: false });
  assert.equal(document.querySelectorAll(".thread").length, 1);
  assert.equal(calls, 1);
});

test("repository browser rejects invalid repository input without contacting the helper", async t => {
  let calls = 0;
  const dom = browser(t, async () => { calls++; return { ok: true, threads: [] }; });
  await tick();
  dom.window.document.getElementById("repository").value = "owner/repo/extra";
  dom.window.document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(calls, 1);
  assert.ok(dom.window.document.getElementById("status").textContent.includes("Enter owner/repository"));
});

test("export contains only displayed threads and preserves incomplete-lookup context", async t => {
  const dom = browser(t, async () => ({ ok: true, truncated: true, environments: [{ name: "Mini", ok: true }], threads: [
    { id: "a", environmentId: "env", title: "Shown", branch: "feature", pullRequests: [{ repository: "owner/repo", number: 42 }] },
    { id: "b", environmentId: "env", title: "Hidden", archived: true },
  ] }));
  await tick();
  await dom.window.T3Settings.update({ includeArchived: false });
  let download;
  let blob;
  dom.window.URL.createObjectURL = value => { blob = value; return "blob:export"; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { download = this.download; };
  dom.window.document.getElementById("export").click();
  const text = await new Promise(resolve => {
    const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob);
  });
  const data = JSON.parse(text);
  assert.equal(download, "owner-repo-t3-links.json");
  assert.equal(data.threads.length, 1);
  assert.equal(data.threads[0].title, "Shown");
  assert.equal(data.threads[0].t3Link, "t3code://threads/env/a");
  assert.deepEqual(data.threads[0].pullRequests, ["https://github.com/owner/repo/pull/42"]);
  assert.equal(data.truncated, true);
});

test("invalid navigation cancels an in-flight repository query and leaves export unavailable", async t => {
  let resolve;
  const dom = browser(t, () => new Promise(done => { resolve = done; }));
  await tick();
  dom.window.document.getElementById("repository").value = "invalid";
  dom.window.document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  resolve({ ok: true, threads: [{ id: "a", environmentId: "env", title: "Stale" }] });
  await tick();
  assert.equal(dom.window.document.querySelectorAll(".thread").length, 0);
  assert.equal(dom.window.document.getElementById("export").disabled, true);
});

test("pasted PR URLs perform an exact lookup and label the loaded PR", async t => {
  const requests = [];
  const dom = browser(t, async request => { requests.push(request); return { ok: true, threads: [] }; });
  await tick();
  const document = dom.window.document;
  document.getElementById("repository").value = "https://github.com/Owner/Repo/pull/57/files?diff=split";
  document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(requests[1].type, "directLookup");
  assert.equal(requests[1].url, "https://github.com/owner/repo/pull/57");
  assert.equal(document.getElementById("page-title").textContent, "PR threads");
  assert.equal(document.getElementById("status").textContent, "Threads for owner/repo #57");
});

test("manual branch lookup preserves branch case/slashes, workspace context, and live-workspace preferences", async t => {
  const requests = [];
  const dom = browser(t, async request => {
    requests.push(request);
    return { ok: true, threads: [{ id: "a", environmentId: "env", title: "Branch work", branch: "old", matchedBranch: "Feature/foo", matchType: "checkout" }] };
  }, "?repository=Owner%2FRepo&branch=Feature%2Ffoo");
  await tick();
  const document = dom.window.document;
  assert.equal(document.getElementById("branch-lookup").open, true);
  assert.equal(requests[0].type, "directBranchLookup");
  assert.equal(requests[0].repository, "owner/repo");
  assert.equal(requests[0].branch, "Feature/foo");
  assert.equal(document.getElementById("page-title").textContent, "Branch threads");
  assert.ok(document.querySelector(".thread").textContent.includes("Matching workspace branch: Feature/foo"));
  await dom.window.T3Settings.update({ liveBranches: false });
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].liveBranches, false);
  assert.equal(requests[1].branch, "Feature/foo");
  document.getElementById("branch").value = "";
  document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(requests[2].type, "repositoryLookup");
});

test("manual branch lookups discard stale results and reject a branch paired with a PR URL", async t => {
  const pending = [];
  const dom = browser(t, request => new Promise(resolve => pending.push({ request, resolve })), "?repository=owner%2Frepo&branch=old");
  await tick();
  const document = dom.window.document;
  document.getElementById("branch").value = "new";
  document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await tick();
  pending[0].resolve({ ok: true, threads: [{ id: "old", environmentId: "env", title: "Old" }] });
  await tick();
  assert.equal(document.querySelectorAll(".thread").length, 0);
  pending[1].resolve({ ok: true, threads: [{ id: "new", environmentId: "env", title: "New" }] });
  await tick();
  assert.equal(document.querySelector(".thread a").textContent, "New ↗");
  document.getElementById("repository").value = "https://github.com/owner/repo/pull/42";
  document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(pending.length, 2);
  assert.ok(document.getElementById("status").textContent.includes("Leave Branch blank"));
  assert.equal(document.getElementById("export").disabled, true);
});

test("branch export identifies the query and the workspace branch separately from the recorded branch", async t => {
  const dom = browser(t, async () => ({ ok: true, threads: [{ id: "a", environmentId: "env", title: "Work", branch: "old", matchedBranch: "Feature/foo", matchType: "checkout" }] }), "?repository=owner%2Frepo&branch=Feature%2Ffoo");
  await tick();
  let blob, download;
  dom.window.URL.createObjectURL = value => { blob = value; return "blob:export"; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { download = this.download; };
  dom.window.document.getElementById("export").click();
  const text = await new Promise(resolve => {
    const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob);
  });
  const data = JSON.parse(text);
  assert.equal(download, "owner-repo-branch-t3-links.json");
  assert.equal(data.branch, "Feature/foo");
  assert.equal(data.threads[0].branch, "old");
  assert.equal(data.threads[0].matchedBranch, "Feature/foo");
});

test("browser filters persist, identify unavailable computers, and restore hidden threads without rescanning", async t => {
  let calls = 0;
  const writes = [];
  const storage = { local: { async get() { return { preferences: { computer: "Mini" } }; }, async set(data) { writes.push(data.preferences); } } };
  const dom = browser(t, async () => {
    calls++;
    return { ok: true, environments: [{ name: "This computer", ok: true }, { name: "Mini", ok: false }], threads: [
      { id: "a", environmentId: "env", title: "Local work" },
      { id: "b", environmentId: "env", title: "Archived work", computer: "Mini", archived: true },
    ] };
  }, undefined, storage);
  await tick();
  const document = dom.window.document;
  assert.equal(document.getElementById("computer").value, "Mini");
  assert.ok(document.getElementById("computer").selectedOptions[0].textContent.includes("unavailable"));
  assert.equal(document.querySelectorAll(".thread").length, 1);
  document.getElementById("includeArchived").checked = false;
  document.getElementById("includeArchived").dispatchEvent(new dom.window.Event("change"));
  await tick();
  assert.equal(writes.at(-1).includeArchived, false);
  assert.equal(document.querySelectorAll(".thread").length, 0);
  assert.equal(document.getElementById("filter-notice").hidden, false);
  document.getElementById("search").value = "absent";
  document.getElementById("search").dispatchEvent(new dom.window.Event("input"));
  document.getElementById("show-all").click();
  await tick();
  assert.equal(document.querySelectorAll(".thread").length, 2);
  assert.equal(document.getElementById("computer").value, "all");
  assert.equal(document.getElementById("search").value, "");
  assert.equal(document.getElementById("filter-notice").hidden, true);
  assert.equal(calls, 1);
});

test("saved filters for a removed computer remain visible and can be recovered", async t => {
  const storage = { local: { async get() { return { preferences: { computer: "Removed computer", liveBranches: false } }; }, async set() {} } };
  const dom = browser(t, async () => ({ ok: true, threads: [{ id: "a", environmentId: "env", title: "Local work" }] }), undefined, storage);
  await tick();
  const document = dom.window.document;
  assert.equal(document.querySelectorAll(".thread").length, 0);
  assert.equal(document.getElementById("computer").value, "Removed computer");
  assert.ok(document.getElementById("computer").selectedOptions[0].textContent.includes("not in this lookup"));
  document.getElementById("show-all").click();
  await tick();
  assert.equal(document.querySelectorAll(".thread").length, 1);
  assert.equal(dom.window.T3Settings.get().liveBranches, false);
});

test("sub-agent threads start hidden, can be shown with a badge, and are restored by show all", async t => {
  let saved = {};
  const storage = { local: { async get() { return { preferences: saved }; }, async set(value) { saved = value.preferences; } } };
  const dom = browser(t, async () => ({ ok: true, threads: [
    { id: "parent", environmentId: "env", title: "Parent work" },
    { id: "child", environmentId: "env", title: "Council review", subagent: true },
  ] }), undefined, storage);
  await tick();
  const document = dom.window.document;
  assert.equal(document.getElementById("includeSubagents").checked, false);
  assert.deepEqual(Array.from(document.querySelectorAll(".thread a"), link => link.textContent), ["Parent work ↗"]);
  assert.equal(document.getElementById("filter-notice").hidden, false);
  document.getElementById("includeSubagents").checked = true;
  document.getElementById("includeSubagents").dispatchEvent(new dom.window.Event("change"));
  await tick();
  assert.equal(saved.includeSubagents, true);
  assert.equal(document.querySelectorAll(".thread").length, 2);
  assert.ok(Array.from(document.querySelectorAll(".t3code-pr-match-kind"), badge => badge.textContent).includes("Sub-agent"));
  await dom.window.T3Settings.update({ includeSubagents: false });
  await tick();
  assert.equal(document.querySelectorAll(".thread").length, 1);
  document.getElementById("show-all").click();
  await tick();
  assert.equal(document.querySelectorAll(".thread").length, 2);
  assert.equal(document.getElementById("includeSubagents").checked, true);
});

test("failed filter saves restore controls and leave the displayed results intact", async t => {
  const storage = { local: { async get() { return {}; }, async set() { throw Error("Storage unavailable"); } } };
  const dom = browser(t, async () => ({ ok: true, threads: [{ id: "a", environmentId: "env", title: "Archived work", archived: true }] }), undefined, storage);
  await tick();
  const document = dom.window.document;
  document.getElementById("includeArchived").checked = false;
  document.getElementById("includeArchived").dispatchEvent(new dom.window.Event("change"));
  await tick();
  assert.equal(document.getElementById("includeArchived").checked, true);
  assert.equal(document.querySelectorAll(".thread").length, 1);
  assert.ok(document.getElementById("settings-error").textContent.includes("Could not save"));
});

test("search finds a current workspace branch when the saved branch is stale", async t => {
  const dom = browser(t, async () => ({ ok: true, threads: [{ id: "a", environmentId: "env", title: "Work", branch: "old", matchedBranch: "feature/current", matchType: "checkout" }] }));
  await tick();
  const document = dom.window.document;
  document.getElementById("search").value = "feature/current";
  document.getElementById("search").dispatchEvent(new dom.window.Event("input"));
  assert.equal(document.querySelectorAll(".thread").length, 1);
});

test("branch lookups keep Unicode spaces that Git allows and trim only ASCII whitespace", async t => {
  const requests = [];
  const dom = browser(t, async request => { requests.push(request); return { ok: true, threads: [] }; }, "?repository=owner%2Frepo&branch=Feature%2Ffoo%C2%A0");
  await tick();
  const document = dom.window.document;
  assert.equal(requests[0].branch, "Feature/foo ");
  assert.equal(document.getElementById("branch").value, "Feature/foo ");
  document.getElementById("branch").value = " \tFeature/foo　 ";
  document.getElementById("lookup").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(requests[1].branch, "Feature/foo　");
  assert.equal(document.getElementById("branch").value, "Feature/foo　");
});
