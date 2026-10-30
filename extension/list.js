(() => {
  const BADGE = "t3code-pr-list-badge";
  let signature = null;
  let version = 0;
  let result = null;
  let pending = false;
  let pendingLookup = null;
  let completedAt = 0;
  let scheduled = false;
  // Kept off the DOM so github.com scripts cannot read unrendered thread fields.
  const rowSignatures = new WeakMap();

  function targets() {
    if (!T3Pr.isPullRequestList(location.href)) return [];
    const found = [];
    for (const link of document.querySelectorAll('main h3 a[href], .js-issue-row a.Link--primary[href], a[data-testid="issue-pr-title-link"][href]')) {
      const pr = T3Pr.parsePullRequest(link.href);
      if (pr) {
        if (found.length === 100) { found.truncated = true; break; }
        found.push({ link, pr });
      }
    }
    return found;
  }

  function placeMenu(badge) {
    const menu = badge.querySelector(".t3code-pr-list-menu");
    if (!menu?.popover || !menu.matches(":popover-open")) return;
    const anchor = badge.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const above = anchor.top - 5 - height;
    const top = anchor.bottom + 5 + height > innerHeight - 8 && above >= 8 ? above : anchor.bottom + 5;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
  }
  function openMenus() { return document.querySelectorAll(`details.${BADGE}[open]`); }

  function removeBadges() { document.querySelectorAll(`.${BADGE}`).forEach(node => node.remove()); }
  function signatureFor(entries) {
    const keys = [...new Set(entries.map(entry => entry.pr.key))].sort();
    return keys.length ? JSON.stringify([location.pathname, location.search, keys, Boolean(entries.truncated)]) : null;
  }

  function render(entries) {
    const count = new Set(entries.filter(({ pr }) => T3Settings.filter(result?.matches?.[pr.key] || []).length).map(({ pr }) => pr.key)).size;
    if (result) globalThis.T3Badge?.set("list", count, !result.ok || Boolean(result.lookupWarnings?.length)
      || (result.environments || []).some(environment => !environment.ok));
    for (const { link, pr } of entries) {
      let badge = link.nextElementSibling?.classList.contains(BADGE) ? link.nextElementSibling : null;
      const threads = T3Settings.sort(T3Settings.filter(result?.matches?.[pr.key] || []));
      const rowSignature = JSON.stringify(threads);
      if (!threads.length) { badge?.remove(); continue; }
      if (rowSignatures.get(badge) === rowSignature) continue;
      badge?.remove();
      if (threads.length === 1) {
        const thread = threads[0];
        const href = T3Pr.threadUrl(thread.environmentId, thread.id);
        if (!href) continue;
        badge = T3Ui.element(document, "a", BADGE, "T3 ↗");
        badge.href = href;
        badge.title = `${thread.title} · ${thread.computer || "This computer"}`;
        badge.setAttribute("aria-label", `Open ${thread.title} in T3 Code on ${thread.computer || "this computer"}`);
      } else {
        badge = T3Ui.element(document, "details", BADGE);
        badge.append(T3Ui.element(document, "summary", "", `T3 · ${threads.length}`));
        const menu = T3Ui.element(document, "div", "t3code-pr-list-menu");
        for (const thread of threads) {
          const row = T3Ui.threadRow(document, thread);
          if (row) menu.append(row);
        }
        badge.append(menu);
        // GitHub's list box clips overflow, so the menu opens in the top layer where supported.
        if (typeof menu.showPopover === "function") {
          menu.popover = "manual";
          badge.addEventListener("toggle", () => {
            if (badge.open && badge.isConnected) { menu.showPopover(); placeMenu(badge); }
            else if (menu.matches(":popover-open")) menu.hidePopover();
          });
        }
      }
      rowSignatures.set(badge, rowSignature);
      link.insertAdjacentElement("afterend", badge);
    }
  }

  async function sync(force = false, forPopup = false) {
    await T3Settings.ready;
    if (!T3Settings.get().listBadges && !forPopup) { removeBadges(); globalThis.T3Badge?.set("none"); return; }
    const entries = targets();
    const nextSignature = signatureFor(entries);
    if (signature !== nextSignature) {
      signature = nextSignature;
      version++;
      pending = false;
      result = null;
      completedAt = 0;
      removeBadges();
      globalThis.T3Badge?.set("none");
    }
    if (!signature) return;
    if (T3Settings.get().listBadges) render(entries);
    if (pending) return pendingLookup;
    if (!force && result) return;
    const requestVersion = version;
    const requestSignature = signature;
    pending = true;
    pendingLookup = (async () => { try {
      const urls = [...new Map(entries.map(({ pr }) => [pr.key, `https://github.com/${pr.repository}/pull/${pr.number}`])).values()];
      const response = await chrome.runtime.sendMessage({ type: "batchLookup", urls });
      if (requestVersion !== version || !T3Pr.isPullRequestList(location.href)) return;
      if (signatureFor(targets()) !== requestSignature) return sync(true, forPopup);
      result = response || { ok: false, error: "No response from T3 Code. Refresh to try again." };
      if (entries.truncated) result = { ...result, truncated: true, lookupWarnings: [...(result.lookupWarnings || []),
        "Only the first 100 PR rows were checked. Narrow the GitHub list to check other PRs."] };
      completedAt = Date.now();
      if (T3Settings.get().listBadges) render(targets());
    } catch {
      if (requestVersion === version) {
        result = { ok: false, error: "The extension was reloaded. Refresh this GitHub tab to reconnect." };
        if (T3Settings.get().listBadges) render(targets());
      }
    }
    finally { if (requestVersion === version) pending = false; }
    })();
    return pendingLookup;
  }

  chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.type !== "listContext" || sender.id !== chrome.runtime.id
        || sender.url !== chrome.runtime.getURL("popup.html") || !T3Pr.isPullRequestList(location.href)) return false;
    void (pending && pendingLookup ? pendingLookup : sync(message.force === true, true)).then(() => {
      if (!T3Pr.isPullRequestList(location.href)) { sendResponse(null); return; }
      const entries = targets();
      sendResponse({ list: { url: location.href }, repository: T3Pr.pageContext(document, location.href).repository,
        pullRequests: [...new Map(entries.filter(({ pr }) => result?.matches?.[pr.key]?.length).map(({ link, pr }) => [pr.key, { ...pr,
          url: `https://github.com/${pr.repository}/pull/${pr.number}`, title: link.textContent.slice(0, 300), threads: result.matches[pr.key] }])).values()],
        result, lastChecked: completedAt });
    });
    return true;
  });

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; void sync(); }, 100);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  for (const event of ["turbo:load", "turbo:render", "pjax:end", "popstate"]) window.addEventListener(event, schedule);
  for (const event of ["scroll", "resize"]) window.addEventListener(event, () => openMenus().forEach(placeMenu), { capture: true, passive: true });
  document.addEventListener("pointerdown", event => {
    for (const badge of openMenus()) if (!badge.contains(event.target)) badge.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    for (const badge of openMenus()) { badge.open = false; badge.querySelector("summary")?.focus(); }
  });
  window.addEventListener("focus", () => void sync());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
  T3Settings.subscribe(() => void sync());
  void sync();
})();
