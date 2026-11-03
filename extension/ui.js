(function (root) {
  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function matchLabel(thread) {
    return thread.matchType === "repository" ? "Repository thread" : thread.matchType === "checkout" ? "Workspace match" : thread.matchType === "branch" ? "Branch match" : "PR linked";
  }

  function matchExplanation(thread) {
    if (thread.matchType === "repository") return "A linked pull request or the workspace's Git remote associates this thread with the repository.";
    if (thread.matchType === "checkout") return "The saved workspace is currently checked out to this source branch and its Git remote matches. The thread's recorded branch may differ.";
    return thread.matchType === "branch"
      ? "The thread's recorded branch and Git remote match this source branch. This does not verify the current checkout."
      : "This pull request is explicitly linked to the thread in T3 Code.";
  }

  function copyButton(document, thread) {
    const href = T3Pr.threadUrl(thread.environmentId, thread.id);
    if (!href) return null;
    const group = element(document, "span", "t3code-pr-copy");
    const button = element(document, "button", "t3code-pr-button", "Copy link");
    button.type = "button";
    button.setAttribute("aria-label", `Copy T3 link for ${thread.title || "Untitled thread"}`);
    const status = element(document, "span", "t3code-pr-copy-status");
    status.setAttribute("role", "status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const clipboard = document.defaultView?.navigator.clipboard;
        if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
        await clipboard.writeText(href);
        status.textContent = "Copied";
        group.querySelector("input")?.remove();
      } catch {
        status.textContent = "Select and copy:";
        let input = group.querySelector("input");
        if (!input) {
          input = element(document, "input", "t3code-pr-copy-value");
          input.readOnly = true;
          input.value = href;
          input.setAttribute("aria-label", "T3 thread link");
          group.append(input);
        }
        input.focus();
        input.select();
      } finally { button.disabled = false; }
    });
    group.append(button, status);
    return group;
  }

  function threadRow(document, thread, { single = false, actions = false, badges = true } = {}) {
    const href = T3Pr.threadUrl(thread.environmentId, thread.id);
    if (!href) return null;
    const row = element(document, "div", "t3code-pr-thread-row");
    const link = element(document, "a", "t3code-pr-thread-link", single ? "Open in T3 Code ↗" : `${thread.title || "Untitled thread"} ↗`);
    link.href = href;
    link.title = thread.title || "Open thread in T3 Code";
    row.append(link);
    const computer = ` · ${thread.computer || "This computer"}`;
    if (single) row.append(element(document, "span", "t3code-pr-thread-title", `${thread.title || "Untitled thread"}${computer}`));
    else row.append(element(document, "span", "t3code-pr-thread-title", thread.computer || "This computer"));
    if (["branch", "checkout"].includes(thread.matchType) || (!single && badges)) {
      const badge = element(document, "span", "t3code-pr-match-kind", matchLabel(thread));
      badge.title = matchExplanation(thread);
      row.append(badge);
    }
    if (thread.subagent) row.append(element(document, "span", "t3code-pr-match-kind", "Sub-agent"));
    if (thread.archived) row.append(element(document, "span", "t3code-pr-match-kind", "Archived"));
    if (actions) row.append(copyButton(document, thread));
    return row;
  }

  function checkoutControl(document, thread) {
    const container = element(document, "div", "t3code-pr-checkout");
    const button = element(document, "button", "t3code-pr-button", "Check current checkout");
    button.type = "button";
    button.setAttribute("aria-label", `Check current checkout for ${thread.title || "Untitled thread"}`);
    const status = element(document, "span", "t3code-pr-checkout-status");
    status.setAttribute("role", "status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Checking saved workspace…";
      try {
        const response = await chrome.runtime.sendMessage({ type: "checkoutLookup", environmentId: thread.environmentId, threadId: thread.id });
        const checkout = response?.threads?.find(record => record.id === thread.id && record.environmentId === thread.environmentId)?.checkout;
        if (!checkout) {
          const unavailable = (response?.environments || []).filter(environment => !environment.ok);
          status.textContent = unavailable.length ? `Could not check: ${unavailable.map(environment => environment.name).join(", ")}.`
            : response?.error || "The thread could not be found on the configured computers.";
        } else if (checkout.state === "branch") {
          status.textContent = `Current checkout: ${checkout.branch}${checkout.matchesRecorded === true ? " · Matches the recorded branch." : checkout.matchesRecorded === false ? " · Differs from the recorded branch." : ""}`;
        } else if (checkout.state === "detached") status.textContent = "Current checkout is a detached HEAD.";
        else status.textContent = checkout.error || "The workspace could not be checked.";
      } catch { status.textContent = "The T3 connection is unavailable. Please try again."; }
      finally { button.disabled = false; }
    });
    container.append(button, status);
    return container;
  }

  function pullRequestLinks(document, thread) {
    if (!Array.isArray(thread.pullRequests)) return null;
    const container = element(document, "p", "t3code-pr-associated-prs");
    for (const pr of thread.pullRequests.slice(0, 30)) {
      const parsed = T3Pr.parsePullRequest(`https://github.com/${pr.repository}/pull/${pr.number}`);
      if (!parsed) continue;
      if (!container.childNodes.length) container.append(document.createTextNode("Linked PRs: "));
      else container.append(document.createTextNode(" · "));
      const link = element(document, "a", "", `${parsed.repository} #${parsed.number}`);
      link.href = `https://github.com/${parsed.repository}/pull/${parsed.number}`;
      link.target = "_blank";
      link.rel = "noopener";
      container.append(link);
    }
    return container.childNodes.length ? container : null;
  }

  root.T3Ui = { element, threadRow, matchLabel, matchExplanation, copyButton, pullRequestLinks, checkoutControl };
})(globalThis);
