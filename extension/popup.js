async function currentPage(force) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    let context = await chrome.tabs.sendMessage(tab.id, { type: "pageContext", force });
    if (!context?.pr && !context?.branch) {
      try { context = await chrome.tabs.sendMessage(tab.id, { type: "listContext", force }) || context; } catch { /* Keep repository context if available. */ }
    }
    if (!context?.pr && !context?.branch && !context?.repository && !context?.list) return null;
    return context;
  } catch { return null; }
}

const installedVersion = chrome.runtime.getManifest?.().version;
if (installedVersion) document.getElementById("version").textContent = `v${installedVersion}`;
document.getElementById("settings-link").href = chrome.runtime.getURL("options.html");
document.getElementById("connect-link").href = chrome.runtime.getURL("options.html");
const threadsUrl = chrome.runtime.getURL("threads.html");
function threadsPage(query = {}) {
  const search = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return search ? `${threadsUrl}?${search}` : threadsUrl;
}
document.getElementById("lookup-link").href = threadsPage();

// Returns the status-line count: PRs with shown threads on lists, otherwise shown threads.
function showContext(context) {
  document.getElementById("context").hidden = !context;
  const container = document.getElementById("threads");
  container.replaceChildren();
  if (!context) return;
  const title = document.getElementById("context-title");
  const repository = context.pr?.repository || context.branch?.repository || context.repository;
  title.textContent = context.pr ? `${repository} #${context.pr.number}` : repository || "Pull requests on this page";
  title.href = context.pr ? `https://github.com/${context.pr.repository}/pull/${context.pr.number}`
    : context.branch ? `https://github.com/${repository}/tree/${encodeURIComponent(context.branch.branch)}` : context.list ? context.list.url : `https://github.com/${repository}`;
  title.target = "_blank";
  title.rel = "noopener";
  // Offer any known source branch, even when the lookup found no branch match.
  const branch = context.branch || context.head;
  document.getElementById("context-branch").hidden = !branch;
  if (branch) {
    const link = document.getElementById("context-branch-link");
    link.textContent = `${branch.repository !== repository ? `${branch.repository} · ` : ""}${branch.branch}`;
    link.href = threadsPage({ repository: branch.repository, branch: branch.branch });
    link.title = `Find T3 threads for branch ${branch.branch} in ${branch.repository}`;
  }
  document.getElementById("browse").href = threadsPage(repository ? { repository } : {});
  const allThreads = context.list ? (context.pullRequests || []).flatMap(pr => pr.threads) : context.result?.threads || [];
  let shown = 0;
  if (context.list) {
    for (const pr of context.pullRequests || []) {
      const visible = T3Settings.sort(T3Settings.filter(pr.threads));
      if (!visible.length) continue;
      shown++;
      const group = T3Ui.element(document, "div", "t3code-pr-popup-group");
      const link = T3Ui.element(document, "a", "t3code-pr-popup-title", `${pr.repository} #${pr.number}`);
      link.href = pr.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = pr.title;
      group.append(link);
      for (const thread of visible) { const row = T3Ui.threadRow(document, thread, { actions: true, badges: false }); if (row) group.append(row); }
      container.append(group);
    }
  } else {
    const threads = T3Settings.sort(T3Settings.filter(allThreads));
    shown = threads.length;
    for (const thread of threads) {
      const row = T3Ui.threadRow(document, thread, { actions: true, badges: false });
      if (row) container.append(row);
    }
  }
  document.getElementById("empty").hidden = shown > 0 || !context.result?.ok;
  document.getElementById("empty").textContent = allThreads.length && !shown
    ? "Matching threads are hidden by your display filters." : "No matching T3 threads on the computers checked.";
  return shown;
}

async function check(force = false) {
  const button = document.getElementById("retry");
  const status = document.getElementById("status");
  const details = document.getElementById("details");
  const connection = document.getElementById("connection");
  button.disabled = true;
  connection.dataset.state = "checking";
  status.textContent = "Checking connections…";
  details.textContent = "";
  details.title = "";
  try {
    await T3Settings.ready;
    const context = await currentPage(force);
    const shown = showContext(context);
    const response = context?.result || await chrome.runtime.sendMessage({ type: "status" });
    document.getElementById("connect-link").hidden = response?.ok === true;
    if (!response?.ok) {
      const errors = response?.environments?.filter(environment => !environment.ok)
        .map(environment => `${environment.name}: ${environment.error}`).join("; ");
      throw new Error(errors || response?.error || "Could not reach T3 Code.");
    }
    const environments = response.environments || [{ name: "This computer", ok: true }];
    updateFilters(environments);
    const available = environments.filter(environment => environment.ok);
    const unavailable = environments.filter(environment => !environment.ok);
    const warnings = response.lookupWarnings || [];
    connection.dataset.state = unavailable.length || warnings.length ? "attention" : "connected";
    status.textContent = unavailable.length ? "Some computers unavailable" : context?.list ? `${shown} linked ${shown === 1 ? "PR" : "PRs"}`
      : context?.result ? `${shown} matching ${shown === 1 ? "thread" : "threads"}` : "Connected to T3 Code";
    details.textContent = `${available.length} ${available.length === 1 ? "computer" : "computers"} connected`;
    details.title = `${unavailable.length ? "Available: " : ""}${available.map(environment => environment.name).join(", ")}`;
    if (unavailable.length) details.textContent = unavailable.map(environment => `${environment.name}: ${environment.error || "unavailable"}`).join("; ");
    if (warnings.length) { status.textContent = "Lookup was incomplete"; details.textContent += ` · ${warnings.join(" ")}`; }
  } catch (error) {
    connection.dataset.state = "attention";
    status.textContent = "Connection needs attention";
    details.textContent = error.message;
  } finally { button.disabled = false; }
}

function updateFilters(environments = []) {
  const preferences = T3Settings.get();
  for (const key of ["includeArchived", "includeBranch", "listBadges", "liveBranches"]) document.getElementById(key).checked = preferences[key];
  const select = document.getElementById("computer");
  const names = new Set([...Array.from(select.options).map(option => option.value).filter(value => value !== "all"),
    ...environments.map(environment => environment.name), ...(preferences.computer === "all" ? [] : [preferences.computer])]);
  select.replaceChildren(T3Ui.element(document, "option", "", "All configured computers"));
  select.firstElementChild.value = "all";
  for (const name of names) {
    const option = T3Ui.element(document, "option", "", name);
    option.value = name;
    select.append(option);
  }
  select.value = preferences.computer;
  document.getElementById("sort").value = preferences.sort;
}
for (const key of ["includeArchived", "includeBranch", "listBadges", "liveBranches", "computer", "sort"]) {
  document.getElementById(key).addEventListener("change", async event => {
    try {
      await T3Settings.update({ [key]: ["computer", "sort"].includes(key) ? event.target.value : event.target.checked });
      document.getElementById("settings-error").textContent = "";
      void check();
    } catch { document.getElementById("settings-error").textContent = "Could not save this preference. Please try again."; updateFilters(); }
  });
}
void T3Settings.ready.then(() => updateFilters());
document.getElementById("retry").addEventListener("click", () => void check(true));
void check();
