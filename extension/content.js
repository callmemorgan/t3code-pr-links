(() => {
  const ID = "t3code-pr-links";
  let currentKey = null;
  let currentQuery = null;
  let generation = 0;
  let result = null;
  let inFlight = false;
  let scheduled = false;
  let lastChecked = 0;
  let pendingLookup = null;
  let settled = null;
  let settledUrl = null;
  // Render signatures stay off the DOM: they hold host fields the panel never shows
  // (workspace paths, projects, raw errors) that github.com scripts could read.
  const signatures = new WeakMap();

  function removePanel() { document.getElementById(ID)?.remove(); }
  function queryFor(context) { return context.query ? JSON.stringify([context.query, T3Settings.get().liveBranches]) : null; }

  // GitHub briefly drops the branch picker or the PR header's branch links while
  // it re-renders. On the same URL, keep the last complete context instead.
  function pageContext() {
    const context = T3Pr.pageContext(document, location.href);
    if (settled?.key && location.href === settledUrl
        && (!context.key || (context.key === settled.key && settled.head && !context.head))) return settled;
    settled = context;
    settledUrl = location.href;
    return context;
  }

  function render() {
    const context = pageContext();
    if (queryFor(context) !== currentQuery) { removePanel(); return; }
    if (!currentKey || !result) { removePanel(); return; }
    const allThreads = Array.isArray(result.threads) ? result.threads : [];
    const threads = T3Settings.sort(T3Settings.filter(allThreads));
    const hiddenCount = allThreads.length - threads.length;
    const unavailable = (result.environments || []).filter(environment => !environment.ok);
    const warnings = result.lookupWarnings || [];
    // The toolbar count does not depend on finding a place for the panel.
    globalThis.T3Badge?.set(context.pr ? "pr" : "branch", threads.length, unavailable.length > 0 || warnings.length > 0 || !result.ok);
    const anchor = context.branch ? document.querySelector("main") : document.querySelector("#partial-discussion-header")
      || document.querySelector(".gh-header")
      || document.querySelector('[data-testid="issue-header"]')
      || document.querySelector('[data-component="PageHeader"][data-has-nav]')
      || document.querySelector('h1[data-component="PH_Title"]')?.closest('[data-component="PageHeader"]');
    if (!anchor) return;
    let panel = document.getElementById(ID);
    if (panel?.dataset.key !== currentKey) { panel?.remove(); panel = null; }
    if (result.ok && !allThreads.length && !unavailable.length && !warnings.length) {
      removePanel();
      return;
    }
    const signature = JSON.stringify([threads, hiddenCount, unavailable, warnings, result.error]);
    if (signatures.get(panel) === signature) {
      const refresh = panel.querySelector('[data-action="refresh"]');
      if (refresh) {
        refresh.disabled = inFlight;
        refresh.textContent = inFlight ? "Checking…" : "Refresh";
        refresh.title = lastChecked ? `Last checked ${new Date(lastChecked).toLocaleTimeString()}` : "Check all configured computers again";
      }
      return;
    }
    if (!panel) {
      panel = document.createElement("section");
      panel.id = ID;
      panel.setAttribute("aria-label", "T3 Code threads");
      panel.dataset.key = currentKey;
      if (context.branch) anchor.prepend(panel);
      else anchor.insertAdjacentElement("afterend", panel);
    }
    signatures.set(panel, signature);
    panel.replaceChildren();
    const mark = document.createElement("span");
    mark.className = "t3code-pr-mark";
    mark.textContent = "T3";
    panel.append(mark);
    const body = T3Ui.element(document, "div", "t3code-pr-body");
    const links = T3Ui.element(document, "div", "t3code-pr-thread-list");
    for (const thread of threads) {
      const row = T3Ui.threadRow(document, thread, { single: threads.length === 1 });
      if (row) links.append(row);
      if (["branch", "checkout"].includes(thread.matchType)) {
        links.append(T3Ui.element(document, "p", "t3code-pr-source-branch", `Matching branch: ${thread.matchedBranch || thread.branch}`));
      }
    }
    body.append(links);
    if (hiddenCount) {
      const notice = T3Ui.element(document, "p", "t3code-pr-filter-notice", `${hiddenCount} ${hiddenCount === 1 ? "thread hidden" : "threads hidden"} by your filters. `);
      const reset = T3Ui.element(document, "button", "t3code-pr-button", "Show all threads");
      reset.type = "button";
      reset.addEventListener("click", async () => {
        try { await T3Settings.update({ includeArchived: true, includeBranch: true, computer: "all" }); }
        catch { notice.textContent = "Could not save filters. Try again in the extension popup."; }
      });
      notice.append(reset);
      body.append(notice);
    }
    if (unavailable.length || !result.ok) {
      const warning = T3Ui.element(document, "p", "t3code-pr-warning", unavailable.length
        ? `Could not check: ${unavailable.map(environment => environment.name).join(", ")}. Available computers may still have matches.`
        : result.error || "T3 Code data could not be read.");
      warning.setAttribute("role", "status");
      body.append(warning);
    }
    for (const text of warnings) body.append(T3Ui.element(document, "p", "t3code-pr-warning", text));
    const controls = T3Ui.element(document, "div", "t3code-pr-controls");
    const refresh = T3Ui.element(document, "button", "t3code-pr-button", "Refresh");
    refresh.type = "button";
    refresh.dataset.action = "refresh";
    refresh.disabled = inFlight;
    refresh.title = lastChecked ? `Last checked ${new Date(lastChecked).toLocaleTimeString()}` : "Check all configured computers again";
    refresh.addEventListener("click", () => void sync(true));
    controls.append(refresh);
    panel.append(body, controls);
  }

  async function sync(force = false) {
    await T3Settings.ready;
    const context = pageContext();
    const { head, branch, key } = context;
    const query = queryFor(context);
    if (query !== currentQuery) {
      currentKey = key;
      currentQuery = query;
      generation++;
      result = null;
      inFlight = false;
      removePanel();
      globalThis.T3Badge?.clear("pr", "branch");
    }
    if (!key) return;
    render();
    if (inFlight) return pendingLookup;
    if (!force && result) return;
    const requestGeneration = generation;
    inFlight = true;
    render();
    pendingLookup = (async () => { try {
      const response = await chrome.runtime.sendMessage(branch
        ? { type: "branchLookup", repository: branch.repository, branch: branch.branch, liveBranches: T3Settings.get().liveBranches }
        : { type: "lookup", url: location.href, liveBranches: T3Settings.get().liveBranches, ...(head ? { head } : {}) });
      if (requestGeneration !== generation) return;
      if (queryFor(pageContext()) !== query) {
        void sync(true);
        return;
      }
      result = response || { ok: false, error: "No response from T3 Code. Refresh to try again." };
      lastChecked = Date.now();
    } catch {
      if (requestGeneration !== generation) return;
      result = { ok: false, error: "The extension was reloaded. Refresh this GitHub tab to reconnect." };
    } finally {
      if (requestGeneration === generation) { inFlight = false; render(); }
    } })();
    return pendingLookup;
  }

  chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.type !== "pageContext" || sender.id !== chrome.runtime.id
        || sender.url !== chrome.runtime.getURL("popup.html")) return false;
    void (inFlight && pendingLookup ? pendingLookup : sync(message.force === true)).then(() => {
      const context = pageContext();
      sendResponse({ pr: context.pr, head: context.head, branch: context.branch,
        repository: context.repository,
        result: queryFor(context) === currentQuery ? result : null, lastChecked });
    });
    return true;
  });

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; void sync(); }, 100);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  for (const event of ["turbo:load", "turbo:render", "pjax:end", "popstate"]) {
    window.addEventListener(event, schedule);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
  window.addEventListener("focus", () => void sync());
  T3Settings.subscribe(() => { render(); void sync(); });
  void sync();
})();
