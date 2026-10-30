(function (root) {
  const defaults = Object.freeze({ includeArchived: true, includeBranch: true, listBadges: true, liveBranches: true, computer: "all", sort: "active" });
  let values = { ...defaults };
  const listeners = new Set();

  function normalize(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
    return {
      includeArchived: input.includeArchived !== false,
      includeBranch: input.includeBranch !== false,
      listBadges: input.listBadges !== false,
      liveBranches: input.liveBranches !== false,
      computer: typeof input.computer === "string" && input.computer.length <= 200 ? input.computer : "all",
      sort: ["active", "recent", "title", "branch", "computer"].includes(input.sort) ? input.sort : "active",
    };
  }

  function apply(input) {
    const next = normalize(input);
    if (JSON.stringify(next) === JSON.stringify(values)) return;
    values = next;
    for (const listener of listeners) listener(values);
  }

  const storage = root.chrome?.storage;
  const contentScript = root.location?.protocol === "https:";
  const ready = contentScript ? root.chrome.runtime.sendMessage({ type: "getPreferences" }).then(data => {
    if (data?.ok) apply(data.preferences);
  }).catch(() => {}) : storage?.local ? storage.local.get("preferences").then(data => apply(data.preferences)).catch(() => {}) : Promise.resolve();
  if (contentScript) root.chrome.runtime.onMessage?.addListener((message, sender) => {
    if (sender.id === root.chrome.runtime.id && !sender.tab && message?.type === "preferencesChanged") apply(message.preferences);
  });
  storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.preferences) apply(changes.preferences.newValue);
  });

  // Send and merge only the changed keys, so a context holding stale values
  // (such as a tab restored from the back/forward cache) cannot overwrite others.
  function changes(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
    const next = normalize({ ...values, ...patch });
    return Object.fromEntries(Object.keys(defaults).filter(key => Object.hasOwn(patch, key)).map(key => [key, next[key]]));
  }

  let updates = Promise.resolve();
  function update(patch) {
    const operation = updates.then(async () => {
      await ready;
      const changed = changes(patch);
      if (contentScript) {
        const response = await root.chrome.runtime.sendMessage({ type: "updatePreferences", patch: changed });
        if (!response?.ok) throw new Error("Could not save display preferences.");
        apply(response.preferences && typeof response.preferences === "object" ? response.preferences : { ...values, ...changed });
      } else if (storage?.local) {
        const next = normalize({ ...normalize((await storage.local.get("preferences")).preferences), ...changed });
        await storage.local.set({ preferences: next });
        apply(next);
      } else apply({ ...values, ...changed });
    });
    updates = operation.catch(() => {});
    return operation;
  }

  function filter(threads = []) {
    return threads.filter(thread => (values.includeArchived || !thread.archived)
      && (values.includeBranch || !["branch", "checkout"].includes(thread.matchType))
      && (values.computer === "all" || (thread.computer || "This computer") === values.computer));
  }

  function sort(threads = [], { repository = false } = {}) {
    const text = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
    const rank = thread => ({ linked: 0, branch: 1, checkout: 2 })[thread.matchType] ?? 3;
    const date = thread => Number.isFinite(Date.parse(thread.updatedAt)) ? Date.parse(thread.updatedAt) : 0;
    return [...threads].sort((a, b) => {
      const matchOrder = repository ? 0 : rank(a) - rank(b);
      if (matchOrder) return matchOrder;
      let order = 0;
      if (values.sort === "active") order = Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || date(b) - date(a);
      else if (values.sort === "recent") order = date(b) - date(a);
      else if (values.sort === "title") order = text(a.title, b.title);
      else if (values.sort === "branch") order = text(a.branch, b.branch);
      else if (values.sort === "computer") order = text(a.computer || "This computer", b.computer || "This computer");
      return order || text(a.title, b.title) || text(`${a.environmentId}:${a.id}`, `${b.environmentId}:${b.id}`);
    });
  }

  root.T3Settings = { defaults, ready, get: () => ({ ...values }), filter, sort, update,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
})(globalThis);
