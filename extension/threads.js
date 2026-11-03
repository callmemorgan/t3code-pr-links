let result = null;
let generation = 0;
let loadedRepository = null;
let loadedPullRequest = null;
let loadedBranch = null;
let activeQuery = null;
let checkedAt = null;
const repositoryInput = document.getElementById("repository");
const branchInput = document.getElementById("branch");
const searchInput = document.getElementById("search");
document.getElementById("settings-link").href = chrome.runtime.getURL?.("options.html") || "options.html";

// Git branch names may contain Unicode spaces (NBSP, U+3000, ...) but never ASCII
// whitespace, so only ASCII whitespace is trimmed from a branch.
function trimBranch(value) { return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""); }

function parseInput(value, branchValue = "") {
  const clean = value.trim();
  const branch = trimBranch(branchValue);
  if (branch && (branch.length > 1024 || /[\x00-\x1f\x7f]/.test(branch))) return null;
  const pr = T3Pr.parsePullRequest(clean);
  if (pr) return branch ? null : { repository: pr.repository, pr, url: `https://github.com/${pr.repository}/pull/${pr.number}` };
  const path = /^https:\/\/github\.com\//i.test(clean) ? T3Pr.repositoryPage(clean)?.repository : clean;
  return typeof path === "string" && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(path) ? { repository: path.toLowerCase(), pr: null, branch: branch || null } : null;
}

function shownThreads() {
  const query = searchInput.value.trim().toLowerCase();
  return T3Settings.sort(T3Settings.filter(result?.threads || []).filter(thread => !query || [thread.title, thread.branch, thread.matchedBranch, thread.project]
    .some(value => typeof value === "string" && value.toLowerCase().includes(query))), { repository: !loadedPullRequest && !loadedBranch });
}

function render() {
  renderFilters();
  const container = document.getElementById("threads");
  container.replaceChildren();
  document.getElementById("filter-notice").hidden = true;
  document.getElementById("export").disabled = !result?.ok || !shownThreads().length;
  if (!result) return;
  const all = result.threads || [];
  const threads = shownThreads();
  document.getElementById("count").textContent = `${threads.length} shown · ${all.length} loaded${result.truncated ? " · More threads exist; results were limited." : ""}`;
  if (all.length > threads.length) {
    document.getElementById("filter-notice").hidden = false;
    document.getElementById("filter-count").textContent = `${all.length - threads.length} hidden by your search or display filters.`;
  }
  for (const thread of threads) {
    const card = T3Ui.element(document, "article", "thread");
    const row = T3Ui.threadRow(document, thread, { actions: true });
    if (!row) continue;
    card.append(row);
    card.append(T3Ui.element(document, "p", "branch", thread.branch ? `Branch: ${thread.branch}` : "No recorded branch"));
    if (thread.matchedBranch && thread.matchedBranch !== thread.branch) card.append(T3Ui.element(document, "p", "branch", `Matching workspace branch: ${thread.matchedBranch}`));
    if (thread.project) card.append(T3Ui.element(document, "p", "branch", `Project: ${thread.project}`));
    if (thread.workspace) card.append(T3Ui.element(document, "p", "branch", `${thread.workspaceType === "worktree" ? "Worktree" : "Workspace"}: ${thread.workspace}`));
    const prs = T3Ui.pullRequestLinks(document, thread);
    if (prs) card.append(prs);
    card.append(T3Ui.checkoutControl(document, thread));
    container.append(card);
  }
  if (!threads.length && result.ok) container.append(T3Ui.element(document, "p", "", all.length
    ? "No threads match your search and display filters." : "No T3 threads found for this lookup on the computers checked."));
}

async function load() {
  const query = parseInput(repositoryInput.value, branchInput.value);
  activeQuery = query;
  const repository = query?.repository;
  const status = document.getElementById("status");
  const requestGeneration = ++generation;
  result = null;
  render();
  document.getElementById("count").textContent = "";
  document.getElementById("coverage").textContent = "";
  if (!repository) {
    status.textContent = T3Pr.parsePullRequest(repositoryInput.value.trim()) && trimBranch(branchInput.value)
      ? "Leave Branch blank when looking up a pull request." : "Enter owner/repository, a GitHub repository URL, or a GitHub PR URL, and a valid optional branch.";
    document.getElementById("load").disabled = false;
    return;
  }
  repositoryInput.value = query.pr ? query.url : repository;
  branchInput.value = query.branch || "";
  const label = query.pr ? `${repository} #${query.pr.number}` : query.branch ? `${repository} · ${query.branch}` : repository;
  status.textContent = `Checking ${label}…`;
  document.getElementById("page-title").textContent = query.pr ? "PR threads" : query.branch ? "Branch threads" : "Repository threads";
  document.getElementById("load").disabled = true;
  try {
    await T3Settings.ready;
    if (requestGeneration !== generation) return;
    const response = await chrome.runtime.sendMessage(query.pr ? { type: "directLookup", url: query.url }
      : query.branch ? { type: "directBranchLookup", repository, branch: query.branch, liveBranches: T3Settings.get().liveBranches }
      : { type: "repositoryLookup", repository });
    if (requestGeneration !== generation) return;
    result = response || { ok: false, error: "No response from T3 Code." };
    loadedRepository = repository;
    loadedPullRequest = query.pr;
    loadedBranch = query.branch || null;
    checkedAt = new Date().toISOString();
    status.textContent = result.ok ? `Threads for ${label}` : result.error || "Could not read T3 data.";
    const environments = result.environments || [{ name: "This computer", ok: result.ok }];
    document.getElementById("coverage").textContent = environments.map(environment => environment.ok
      ? `${environment.name}: connected` : `${environment.name}: ${environment.error || "unavailable"}`).join(" · ");
    if (result.lookupWarnings?.length) document.getElementById("coverage").textContent += ` ${result.lookupWarnings.join(" ")}`;
    render();
  } catch { if (requestGeneration === generation) status.textContent = "The T3 connection is unavailable. Check the extension connection and try again."; }
  finally { if (requestGeneration === generation) document.getElementById("load").disabled = false; }
}

document.getElementById("export").addEventListener("click", () => {
  if (!result?.ok || !shownThreads().length) return;
  const data = {
    repository: loadedRepository, pullRequest: loadedPullRequest?.number || null, branch: loadedBranch, checkedAt, search: searchInput.value.trim(),
    truncated: Boolean(result.truncated), lookupWarnings: result.lookupWarnings || [],
    computers: (result.environments || [{ name: "This computer", ok: true }]).map(({ name, ok }) => ({ name, available: ok })),
    threads: shownThreads().map(thread => ({
      title: thread.title, computer: thread.computer || "This computer", branch: thread.branch || null,
      matchedBranch: thread.matchedBranch || null, matchType: thread.matchType || null,
      project: thread.project || null, archived: Boolean(thread.archived),
      t3Link: T3Pr.threadUrl(thread.environmentId, thread.id),
      pullRequests: (thread.pullRequests || []).flatMap(pr => {
        const parsed = T3Pr.parsePullRequest(`https://github.com/${pr.repository}/pull/${pr.number}`);
        return parsed ? [`https://github.com/${parsed.repository}/pull/${parsed.number}`] : [];
      }),
    })),
  };
  try {
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${loadedRepository.replace("/", "-")}${loadedPullRequest ? `-pr-${loadedPullRequest.number}` : loadedBranch ? "-branch" : ""}-t3-links.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById("status").textContent = `Exported ${data.threads.length} shown thread links.`;
  } catch { document.getElementById("status").textContent = "The export could not be created. Please try again."; }
});

document.getElementById("lookup").addEventListener("submit", event => { event.preventDefault(); void load(); });
searchInput.addEventListener("input", render);

function renderFilters() {
  const preferences = T3Settings.get();
  for (const key of ["includeArchived", "includeBranch", "includeSubagents", "liveBranches"]) document.getElementById(key).checked = preferences[key];
  const computers = new Map((result?.environments || []).map(environment => [environment.name, environment.ok]));
  for (const thread of result?.threads || []) {
    const name = thread.computer || "This computer";
    if (!computers.has(name)) computers.set(name, true);
  }
  if (preferences.computer !== "all" && !computers.has(preferences.computer)) computers.set(preferences.computer, null);
  const select = document.getElementById("computer");
  const all = T3Ui.element(document, "option", "", "All configured computers");
  all.value = "all";
  select.replaceChildren(all);
  for (const [name, ok] of computers) {
    const option = T3Ui.element(document, "option", "", `${name}${ok === false ? " (unavailable)" : ok === null ? " (not in this lookup)" : ""}`);
    option.value = name;
    select.append(option);
  }
  select.value = preferences.computer;
}

for (const key of ["includeArchived", "includeBranch", "includeSubagents", "liveBranches", "computer"]) {
  document.getElementById(key).addEventListener("change", async event => {
    try {
      await T3Settings.update({ [key]: key === "computer" ? event.target.value : event.target.checked });
      document.getElementById("settings-error").textContent = "";
    } catch {
      document.getElementById("settings-error").textContent = "Could not save this preference. Please try again.";
      renderFilters();
    }
  });
}
document.getElementById("show-all").addEventListener("click", async () => {
  try {
    await T3Settings.update({ includeArchived: true, includeBranch: true, includeSubagents: true, computer: "all" });
    searchInput.value = "";
    document.getElementById("settings-error").textContent = "";
    render();
  } catch { document.getElementById("settings-error").textContent = "Could not reset your display filters. Please try again."; }
});
const sortInput = document.getElementById("sort");
sortInput.addEventListener("change", async () => {
  try { await T3Settings.update({ sort: sortInput.value }); }
  catch { document.getElementById("status").textContent = "Could not save the thread order. Try again."; sortInput.value = T3Settings.get().sort; }
});
let liveBranches = T3Settings.get().liveBranches;
function preferencesChanged() {
  const preferences = T3Settings.get();
  sortInput.value = preferences.sort;
  const changed = preferences.liveBranches !== liveBranches;
  liveBranches = preferences.liveBranches;
  if (changed && activeQuery?.branch) void load();
  else render();
}
T3Settings.subscribe(preferencesChanged);
void T3Settings.ready.then(preferencesChanged);
const initialParameters = new URL(location.href).searchParams;
const initial = initialParameters.get("repository");
if (initial) {
  repositoryInput.value = initial;
  branchInput.value = initialParameters.get("branch") || "";
  document.getElementById("branch-lookup").open = Boolean(branchInput.value);
  void load();
}
