(function (root) {
  let signature = null;
  let shown = null;
  function set(kind, count = 0, problem = false) {
    const next = JSON.stringify([location.href, kind, count, problem]);
    if (next === signature) return;
    signature = next;
    shown = kind;
    void chrome.runtime.sendMessage({ type: "badge", url: location.href, kind, count, problem }).catch(() => {});
  }
  // The PR panel and PR-list scripts share the toolbar badge. Each clears only its own kinds.
  function clear(...kinds) { if (kinds.includes(shown)) set("none"); }
  root.T3Badge = { set, clear };
})(globalThis);
