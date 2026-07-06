const formatNumber = new Intl.NumberFormat();
const formatDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  year: "numeric",
});
const formatDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const state = {
  overview: null,
  domains: [],
  sources: [],
  actions: [],
  timeline: [],
  reports: [],
  events: [],
  geo: { points: [], unresolved_sources: 0 },
  user: null,
  users: [],
  oidcSettings: null,
  mailboxSchedulerStatus: null,
  trendRange: "30d",
  domainPage: 1,
  domainSearch: "",
  domainsPerPage: 12,
  domainSort: { key: "messages", direction: "desc" },
  dashboardQuery: "",
  dashboardFilters: loadDashboardFilters(),
};

let geoMapInstance = null;
let geoLayerGroup = null;
let activeTooltipTrigger = null;
let appTooltip = null;
let manualSidebarActiveUntil = 0;
let currentPage = "dashboard";
let searchTimer = null;
let dashboardFilterTimer = null;
let searchAbortController = null;
let searchResults = [];

const sidebarLinks = [...document.querySelectorAll(".sidebar .nav-link[href^='#']")];
const themeToggle = document.getElementById("theme-toggle");
const globalSearchInput = document.getElementById("global-search-input");
const globalSearchResults = document.getElementById("global-search-results");
const dashboardFilterForm = document.getElementById("dashboard-filter-form");
const dashboardFilterInput = document.getElementById("dashboard-filter-input");
const dashboardFilterChips = document.getElementById("dashboard-filter-chips");

syncThemeToggle();
renderInitialSkeletons();

themeToggle?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-bs-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
});

document.getElementById("upload-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("file-input");
  const status = document.getElementById("upload-status");
  if (!input.files.length) return;

  const body = new FormData();
  for (const file of input.files) body.append("file", file);

  status.textContent = "Processing reports...";
  const response = await fetch("/api/import", { method: "POST", body });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Import failed" }));
    status.textContent = error.error;
    return;
  }

  const result = await response.json();
  status.textContent = `${result.imported} imported · ${result.duplicates} duplicate`;
  input.value = "";
  await load();
});

document.getElementById("mailbox-sync").addEventListener("click", async () => {
  await syncMailbox(document.getElementById("upload-status"));
});

document.getElementById("report-select").addEventListener("change", (event) => {
  if (event.target.value) loadDetail(event.target.value);
});

globalSearchInput?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = globalSearchInput.value.trim();
  if (query.length < 2) {
    hideGlobalSearch();
    return;
  }

  searchTimer = setTimeout(() => runGlobalSearch(query), 180);
});

globalSearchInput?.addEventListener("focus", () => {
  if (globalSearchInput.value.trim().length >= 2 && searchResults.length) showGlobalSearch();
});

globalSearchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideGlobalSearch();
    globalSearchInput.blur();
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".global-search")) hideGlobalSearch();
});

sidebarLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const hash = link.getAttribute("href");
    showPageForHash(hash);
    const target = document.querySelector(hash);
    manualSidebarActiveUntil = Date.now() + 900;
    setActiveSidebarLink(hash);
    history.pushState(null, "", urlForHash(hash));
    target?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible && currentPage === "dashboard" && Date.now() > manualSidebarActiveUntil) {
        setActiveSidebarLink(`#${visible.target.id}`);
      }
    },
    { rootMargin: "-18% 0px -65% 0px", threshold: [0.15, 0.4, 0.7] },
  );
  sidebarLinks
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean)
    .forEach((section) => observer.observe(section));
}

document.querySelectorAll("[data-domain-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.domainSort;
    if (state.domainSort.key === key) {
      state.domainSort.direction = state.domainSort.direction === "asc" ? "desc" : "asc";
    } else {
      state.domainSort = { key, direction: defaultDomainSortDirection(key) };
    }
    state.domainPage = 1;
    renderDomains();
  });
});

document.getElementById("domains-search-input").addEventListener("input", (event) => {
  state.domainSearch = event.target.value.trim().toLowerCase();
  state.domainPage = 1;
  renderDomains();
});

document.querySelectorAll("[data-trend-range]").forEach((button) => {
  button.addEventListener("click", () => {
    state.trendRange = button.dataset.trendRange;
    renderTrendRange();
    renderTrend();
    renderParsedmarcDashboard();
  });
});

dashboardFilterInput?.addEventListener("input", (event) => {
  clearTimeout(dashboardFilterTimer);
  event.stopPropagation();
});

dashboardFilterForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  addDashboardFilterFromInput("include", false);
});

document.getElementById("dashboard-filter-exclude")?.addEventListener("click", () => {
  addDashboardFilterFromInput("exclude", false);
});

document.getElementById("dashboard-filter-pin")?.addEventListener("click", () => {
  addDashboardFilterFromInput("include", true);
});

document.getElementById("dashboard-filter-clear")?.addEventListener("click", () => {
  clearTimeout(dashboardFilterTimer);
  state.dashboardQuery = "";
  state.dashboardFilters = [];
  if (dashboardFilterInput) dashboardFilterInput.value = "";
  saveDashboardFilters();
  renderFilteredDashboard();
});

dashboardFilterChips?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter-action]");
  if (!button) return;
  const index = Number(button.dataset.filterIndex);
  const filter = state.dashboardFilters[index];
  if (!filter) return;

  if (button.dataset.filterAction === "remove") {
    state.dashboardFilters.splice(index, 1);
  } else if (button.dataset.filterAction === "pin") {
    filter.pinned = !filter.pinned;
  } else if (button.dataset.filterAction === "mode") {
    filter.mode = filter.mode === "exclude" ? "include" : "exclude";
  }

  saveDashboardFilters();
  renderFilteredDashboard();
});

document.getElementById("domain-modal-close").addEventListener("click", closeDomainModal);
document.querySelector("[data-domain-modal-close]").addEventListener("click", closeDomainModal);
document.getElementById("protocol-modal-close").addEventListener("click", closeProtocolModal);
document.querySelector("[data-protocol-modal-close]").addEventListener("click", closeProtocolModal);
document.getElementById("source-modal-close").addEventListener("click", closeSourceModal);
document.querySelector("[data-source-modal-close]").addEventListener("click", closeSourceModal);
document.getElementById("action-modal-close").addEventListener("click", closeActionModal);
document.querySelector("[data-action-modal-close]").addEventListener("click", closeActionModal);
document.getElementById("score-modal-close").addEventListener("click", closeScoreModal);
document.querySelector("[data-score-modal-close]").addEventListener("click", closeScoreModal);
document.getElementById("policy-modal-close").addEventListener("click", closePolicyModal);
document.querySelector("[data-policy-modal-close]").addEventListener("click", closePolicyModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDomainModal();
    closeProtocolModal();
    closeSourceModal();
    closeActionModal();
    closeScoreModal();
    closePolicyModal();
  }
});

document.addEventListener("mouseover", (event) => {
  const trigger = event.target.closest("[data-tooltip]");
  if (trigger) showAppTooltip(trigger);
});
document.addEventListener("mouseout", (event) => {
  const trigger = event.target.closest("[data-tooltip]");
  if (trigger && !trigger.contains(event.relatedTarget)) hideAppTooltip();
});
document.addEventListener("focusin", (event) => {
  const trigger = event.target.closest("[data-tooltip]");
  if (trigger) showAppTooltip(trigger);
});
document.addEventListener("focusout", (event) => {
  const trigger = event.target.closest("[data-tooltip]");
  if (trigger) hideAppTooltip();
});
window.addEventListener("scroll", hideAppTooltip, true);
window.addEventListener("resize", hideAppTooltip);
window.addEventListener("hashchange", () => showPageForHash(currentNavigationHash(), true));
window.addEventListener("popstate", () => showPageForHash(currentNavigationHash(), true));

document.getElementById("mailbox-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("settings-status");
  status.textContent = "Saving...";

  const response = await fetch("/api/settings/mailbox", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mailboxFormPayload()),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Save failed" }));
    status.textContent = error.error;
    return;
  }

  const settings = await response.json();
  fillMailboxForm(settings);
  status.textContent = "Saved";
  await refreshMailboxSchedulerStatus();
});

document.getElementById("mailbox-test").addEventListener("click", async () => {
  const status = document.getElementById("settings-status");
  status.textContent = "Testing connection...";

  const response = await fetch("/api/settings/mailbox/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mailboxFormPayload()),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Connection failed" }));
    status.textContent = error.error;
    return;
  }

  const result = await response.json();
  status.textContent = `Connected · ${result.matched_count} match filters · ${result.would_scan} will be scanned · ${result.message_count} total`;
});

document.getElementById("mailbox-sync-settings").addEventListener("click", async () => {
  await syncMailbox(document.getElementById("settings-status"));
});

setInterval(() => {
  refreshMailboxSchedulerStatus().catch(() => {});
}, 30_000);

document.getElementById("profile-toggle").addEventListener("click", () => {
  const menu = document.getElementById("profile-dropdown");
  const expanded = menu.hidden;
  menu.hidden = !expanded;
  document.getElementById("profile-toggle").setAttribute("aria-expanded", String(expanded));
});

document.addEventListener("click", (event) => {
  const menu = document.getElementById("profile-dropdown");
  const wrapper = event.target.closest(".profile-menu");
  if (!wrapper && !menu.hidden) {
    menu.hidden = true;
    document.getElementById("profile-toggle").setAttribute("aria-expanded", "false");
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  await fetch("/api/auth/login", { method: "DELETE" });
  window.location.href = "/login";
});

document.getElementById("change-password-link").addEventListener("click", () => {
  const menu = document.getElementById("profile-dropdown");
  menu.hidden = true;
  document.getElementById("profile-toggle").setAttribute("aria-expanded", "false");
  window.setTimeout(() => {
    document.querySelector(`tr[data-user-id="${state.user?.id}"] [data-user-field='password']`)?.focus();
  }, 250);
});

document.getElementById("create-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("user-management-status");
  const password = document.getElementById("new-user-password").value;
  if (password.length < 8) {
    status.textContent = "Password must be at least 8 characters.";
    return;
  }

  status.textContent = "Creating user...";
  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: document.getElementById("new-user-username").value.trim(),
      display_name: document.getElementById("new-user-display-name").value.trim(),
      email: document.getElementById("new-user-email").value.trim(),
      password,
      active: document.getElementById("new-user-active").checked,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "User creation failed" }));
    status.textContent = error.error;
    return;
  }

  document.getElementById("create-user-form").reset();
  document.getElementById("new-user-active").checked = true;
  status.textContent = "User created";
  await refreshUsers();
});

document.getElementById("users-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-user-action]");
  if (!button) return;

  const row = button.closest("tr[data-user-id]");
  const userId = row?.dataset.userId;
  if (!userId) return;

  if (button.dataset.userAction === "save") {
    await saveManagedUser(row);
  }
  if (button.dataset.userAction === "delete") {
    await deleteManagedUser(row);
  }
});

document.getElementById("oidc-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("auth-settings-status");
  status.textContent = "Saving...";

  const response = await fetch("/api/settings/oidc", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(oidcFormPayload()),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Save failed" }));
    status.textContent = error.error;
    return;
  }

  const settings = await response.json();
  state.oidcSettings = settings;
  fillOidcForm(settings);
  status.textContent = "Saved";
});

async function load() {
  renderInitialSkeletons();
  const [session, overview, domains, sources, actions, timeline, reports, events, geo, mailboxSettings, mailboxSchedulerStatus, oidcSettings, users] = await Promise.all([
    fetchJson("/api/auth/session"),
    fetchJson("/api/overview"),
    fetchJson("/api/domains"),
    fetchJson("/api/top-sources"),
    fetchJson("/api/action-items"),
    fetchJson("/api/timeline"),
    fetchJson("/api/reports"),
    fetchJson("/api/events"),
    fetchJson("/api/geo-sources"),
    fetchJson("/api/settings/mailbox"),
    fetchJson("/api/mailbox/scheduler/status"),
    fetchJson("/api/settings/oidc"),
    fetchJson("/api/users").catch(() => []),
  ]);

  state.user = session.user;
  state.users = users;
  state.overview = overview;
  state.domains = domains;
  state.sources = sources;
  state.actions = actions;
  state.timeline = timeline;
  state.reports = reports;
  state.events = events;
  state.geo = geo;
  state.mailboxSchedulerStatus = mailboxSchedulerStatus;
  state.oidcSettings = oidcSettings;
  state.domainPage = Math.min(state.domainPage, Math.max(1, Math.ceil(state.domains.length / state.domainsPerPage)));

  renderProfile();
  renderTrendRange();
  renderFilteredDashboard();
  renderProtocols();
  renderDomains();
  renderSources();
  renderActions();
  renderEvidence();
  fillMailboxForm(mailboxSettings);
  renderMailboxSchedulerStatus(mailboxSchedulerStatus);
  fillOidcForm(oidcSettings);
  renderUsers();
  showPageForHash(currentNavigationHash(), true);
}

function renderInitialSkeletons() {
  renderDashboardSkeletons();
  renderSectionSkeletons();
}

function renderDashboardSkeletons() {
  if (dashboardFilterChips) {
    dashboardFilterChips.innerHTML = `
      <span class="parsed-filter-count skeleton-pill"></span>
      <span class="skeleton-pill short"></span>
      <span class="skeleton-pill"></span>
    `;
  }

  setSkeletonHtml("parsed-spf-alignment", skeletonKpi());
  setSkeletonHtml("parsed-dkim-alignment", skeletonKpi());
  setSkeletonHtml("parsed-dmarc-passage", skeletonKpi());
  setSkeletonHtml("trend", skeletonChart());
  setSkeletonHtml("parsed-spf-trend", skeletonMiniChart());
  setSkeletonHtml("parsed-dkim-trend", skeletonMiniChart());
  setSkeletonHtml("parsed-disposition-trend", skeletonMiniChart());
  setSkeletonHtml("parsed-reporting-orgs", skeletonList(5));
  setSkeletonHtml("parsed-reverse-dns", skeletonTable(5, 5));
  setSkeletonHtml("parsed-header-from", skeletonList(5));
  setSkeletonHtml("geo-map", `<div class="skeleton-map"></div>`);
  setSkeletonHtml("geo-list", skeletonList(5));
  setSkeletonHtml("parsed-source-ips", skeletonTable(6, 5));
  setSkeletonHtml("parsed-spf-details", skeletonTable(5, 4));
  setSkeletonHtml("parsed-reverse-dns-trend", skeletonTable(5, 4));
  setSkeletonHtml("parsed-dkim-details", skeletonTable(5, 4));
  setSkeletonHtml("protocols", skeletonList(4));
}

function renderSectionSkeletons() {
  setSkeletonHtml("domains-body", `
    ${Array.from({ length: 6 }, () => `
      <tr class="skeleton-table-row">
        ${Array.from({ length: 6 }, () => `<td><span class="skeleton-line"></span></td>`).join("")}
      </tr>
    `).join("")}
  `);
  setSkeletonHtml("sources-list", skeletonCards(4));
  setSkeletonHtml("actions-list", skeletonCards(4));
  setSkeletonHtml("policy-mix", skeletonMiniBars(3));
  setSkeletonHtml("detail-content", skeletonCards(2));
}

function setSkeletonHtml(id, html) {
  const target = document.getElementById(id);
  if (target) target.innerHTML = html;
}

function skeletonKpi() {
  return `
    <div class="skeleton-kpi">
      <span class="skeleton-line value"></span>
      <span class="skeleton-line"></span>
      <div class="skeleton-kpi-grid">
        <span class="skeleton-block"></span>
        <span class="skeleton-block"></span>
        <span class="skeleton-block"></span>
      </div>
    </div>
  `;
}

function skeletonChart() {
  return `<div class="skeleton-chart"><span></span><span></span><span></span><span></span></div>`;
}

function skeletonMiniChart() {
  return `<div class="skeleton-mini-chart"><span></span><span></span><span></span></div>`;
}

function skeletonList(count) {
  return Array.from({ length: count }, () => `
    <article class="skeleton-list-row">
      <div>
        <span class="skeleton-line"></span>
        <span class="skeleton-line short"></span>
      </div>
      <span class="skeleton-line number"></span>
    </article>
  `).join("");
}

function skeletonTable(rows, columns) {
  return `
    <table class="parsed-table skeleton-table">
      <tbody>
        ${Array.from({ length: rows }, () => `
          <tr>
            ${Array.from({ length: columns }, () => `<td><span class="skeleton-line"></span></td>`).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function skeletonCards(count) {
  return Array.from({ length: count }, () => `
    <article class="skeleton-card">
      <span class="skeleton-line"></span>
      <span class="skeleton-line short"></span>
      <span class="skeleton-line"></span>
    </article>
  `).join("");
}

function skeletonMiniBars(count) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-mini-bar">
      <span class="skeleton-line short"></span>
      <span class="skeleton-line"></span>
    </div>
  `).join("");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${url}`);
  return response.json();
}

async function runGlobalSearch(query) {
  searchAbortController?.abort();
  searchAbortController = new AbortController();
  renderGlobalSearchStatus("Searching...");

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      signal: searchAbortController.signal,
    });
    if (!response.ok) throw new Error("Search failed");
    const payload = await response.json();
    searchResults = payload.results || [];
    renderGlobalSearchResults(searchResults, query);
  } catch (error) {
    if (error.name === "AbortError") return;
    renderGlobalSearchStatus("Search unavailable.");
  }
}

function renderGlobalSearchStatus(message) {
  globalSearchResults.innerHTML = `<div class="global-search-state">${escapeHtml(message)}</div>`;
  showGlobalSearch();
}

function renderGlobalSearchResults(results, query) {
  if (!results.length) {
    renderGlobalSearchStatus(`No result for "${query}".`);
    return;
  }

  globalSearchResults.innerHTML = results
    .map(
      (result, index) => `
      <button class="global-search-result" type="button" data-search-index="${index}">
        <span class="global-search-kind">${escapeHtml(result.kind)}</span>
        <strong>${escapeHtml(result.title)}</strong>
        <small>${escapeHtml(result.subtitle)}</small>
        <em>${escapeHtml(result.detail)}</em>
      </button>
    `,
    )
    .join("");

  globalSearchResults.querySelectorAll("[data-search-index]").forEach((button) => {
    button.addEventListener("click", () => openSearchResult(searchResults[Number(button.dataset.searchIndex)]));
  });
  showGlobalSearch();
}

function showGlobalSearch() {
  globalSearchResults.hidden = false;
  globalSearchInput.setAttribute("aria-expanded", "true");
}

function hideGlobalSearch() {
  globalSearchResults.hidden = true;
  globalSearchInput?.setAttribute("aria-expanded", "false");
}

async function openSearchResult(result) {
  if (!result) return;
  hideGlobalSearch();

  if (result.kind === "domain" && result.domain) {
    revealSection("#domains");
    openDomainModal(result.domain);
    return;
  }

  if (result.kind === "report" || result.kind === "record") {
    revealSection("#evidence");
    if (result.report_id) {
      document.getElementById("report-select").value = result.report_id;
      await loadDetail(result.report_id);
    }
    return;
  }

  if (result.kind === "action") {
    revealSection("#remediation");
    return;
  }

  if (result.kind === "source") {
    revealSection("#sources");
    return;
  }

  revealSection(result.domain ? "#domains" : "#sources");
}

function revealSection(hash) {
  showPageForHash(hash);
  const target = document.querySelector(hash);
  if (!target) return;
  setActiveSidebarLink(hash);
  history.pushState(null, "", urlForHash(hash));
  target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
}

function showPageForHash(hash, scrollIntoView = false) {
  const normalizedHash = hash || "#overview";
  const page = pageForHash(normalizedHash);
  currentPage = page;

  document.querySelectorAll(".content-inner > section").forEach((section) => {
    const isStandalonePage = section.id === "settings" || section.id === "authentication";
    section.hidden = page === "dashboard" ? isStandalonePage : section.id !== page;
  });

  setActiveSidebarLink(normalizedHash);

  if (scrollIntoView) {
    const target = document.querySelector(normalizedHash);
    target?.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
  }
}

function pageForHash(hash) {
  if (hash === "#settings") return "settings";
  if (hash === "#authentication") return "authentication";
  return "dashboard";
}

function currentNavigationHash() {
  if (window.location.hash) return window.location.hash;
  if (window.location.pathname === "/settings") return "#settings";
  if (window.location.pathname === "/authentication") return "#authentication";
  return "#overview";
}

function urlForHash(hash) {
  if (hash === "#settings") return "/settings";
  if (hash === "#authentication") return "/authentication";
  if (hash === "#overview") return "/";
  return `/${hash}`;
}

async function refreshMailboxSchedulerStatus() {
  const schedulerStatus = await fetchJson("/api/mailbox/scheduler/status");
  state.mailboxSchedulerStatus = schedulerStatus;
  renderMailboxSchedulerStatus(schedulerStatus);
}

async function refreshUsers() {
  state.users = await fetchJson("/api/users");
  const current = state.users.find((user) => user.id === state.user?.id);
  if (current) {
    state.user = {
      id: current.id,
      username: current.username,
      email: current.email,
      display_name: current.display_name,
      role: current.role,
      auth_type: current.auth_type,
    };
  }
  renderUsers();
}

function renderUsers() {
  const body = document.getElementById("users-body");
  if (!body) return;
  if (!state.users.length) {
    body.innerHTML = `<tr><td colspan="5">No users found.</td></tr>`;
    return;
  }

  body.innerHTML = state.users
    .map((user) => {
      const isCurrentUser = state.user?.id === user.id;
      const isLocal = user.auth_type === "local";
      return `
        <tr data-user-id="${escapeHtml(user.id)}" data-auth-type="${escapeHtml(user.auth_type)}">
          <td>
            <strong>${escapeHtml(user.username)}</strong>
            ${isCurrentUser ? `<span class="badge bg-primary ms-2">You</span>` : ""}
            <div class="row g-2 mt-2">
              <div class="col-md-6">
                <input class="form-control form-control-sm" data-user-field="display_name" value="${escapeHtml(user.display_name)}" aria-label="Display name for ${escapeHtml(user.username)}">
              </div>
              <div class="col-md-6">
                <input class="form-control form-control-sm" data-user-field="email" type="email" value="${escapeHtml(user.email)}" aria-label="Email for ${escapeHtml(user.username)}">
              </div>
            </div>
          </td>
          <td><span class="status-badge neutral">${escapeHtml(user.auth_type.toUpperCase())}</span></td>
          <td>
            <div class="form-check form-switch">
              <input class="form-check-input" data-user-field="active" type="checkbox" ${user.active ? "checked" : ""} ${isCurrentUser ? "disabled" : ""} aria-label="Active status for ${escapeHtml(user.username)}">
            </div>
          </td>
          <td class="user-password-cell">
            <div class="user-inline-control">
              <input class="form-control form-control-sm" data-user-field="password" type="password" autocomplete="new-password" placeholder="${isCurrentUser ? "New password" : isLocal ? "Leave blank" : "OIDC managed"}" ${isLocal ? "" : "disabled"}>
            </div>
          </td>
          <td class="text-end">
            <div class="user-inline-control d-flex justify-content-end gap-2 flex-wrap">
              <button class="btn btn-sm btn-primary" type="button" data-user-action="save">Save</button>
              <button class="btn btn-sm btn-outline-danger" type="button" data-user-action="delete" ${isCurrentUser ? "disabled" : ""}>Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function saveManagedUser(row) {
  const status = document.getElementById("user-management-status");
  const userId = row.dataset.userId;
  const password = row.querySelector("[data-user-field='password']").value;
  if (password && password.length < 8) {
    status.textContent = "Password must be at least 8 characters.";
    return;
  }

  status.textContent = "Saving user...";
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: row.querySelector("[data-user-field='display_name']").value.trim(),
      email: row.querySelector("[data-user-field='email']").value.trim(),
      role: "Administrator",
      active: row.querySelector("[data-user-field='active']").checked,
      password,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "User save failed" }));
    status.textContent = error.error;
    return;
  }

  status.textContent = "User saved";
  await refreshUsers();
  renderProfile();
}

async function deleteManagedUser(row) {
  const status = document.getElementById("user-management-status");
  const user = state.users.find((item) => item.id === row.dataset.userId);
  if (!user || !window.confirm(`Delete user ${user.username}?`)) return;

  status.textContent = "Deleting user...";
  const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "User deletion failed" }));
    status.textContent = error.error;
    return;
  }

  status.textContent = "User deleted";
  await refreshUsers();
}

function setActiveSidebarLink(hash) {
  sidebarLinks.forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === hash);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-bs-theme", theme);
  localStorage.setItem("dmarcontrol-theme", theme);
  syncThemeToggle();
  syncThemeLogos();
}

function syncThemeToggle() {
  if (!themeToggle) return;
  const theme = document.documentElement.getAttribute("data-bs-theme") || "light";
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  themeToggle.setAttribute("title", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  syncThemeLogos();
}

function syncThemeLogos() {
  const theme = document.documentElement.getAttribute("data-bs-theme") || "light";
  const logoSrc = theme === "dark"
    ? "/assets/brand/dmarcontrol-logo-dark.svg"
    : "/assets/brand/dmarcontrol-logo.svg";
  document.querySelectorAll(".app-logo, .auth-logo").forEach((logo) => {
    if (logo.getAttribute("src") !== logoSrc) logo.setAttribute("src", logoSrc);
  });
}

function renderFilteredDashboard({ includeMap = true } = {}) {
  renderDashboardFilters();
  renderOverview();
  renderTrend();
  renderParsedmarcDashboard();
  if (includeMap) renderGeoMap();
}

function addDashboardFilterFromInput(mode, pinned) {
  clearTimeout(dashboardFilterTimer);
  state.dashboardQuery = dashboardFilterInput?.value.trim() || "";
  const draft = dashboardFilterInput?.value.trim() || "";
  if (!draft) return;
  const filter = parseDashboardFilter(draft, mode, pinned);
  addDashboardFilter(filter);
  state.dashboardQuery = "";
  dashboardFilterInput.value = "";
}

function addDashboardFilter(filter) {
  if (!filter?.value) return;
  const duplicate = state.dashboardFilters.some((item) =>
    item.field === filter.field &&
    item.value.toLowerCase() === filter.value.toLowerCase() &&
    item.mode === filter.mode
  );
  if (!duplicate) state.dashboardFilters.push(filter);
  saveDashboardFilters();
  renderFilteredDashboard();
}

function addDashboardFilterValue(field, value, mode = "include", pinned = false) {
  addDashboardFilter({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field: normalizeDashboardField(field) || "all",
    value: String(value || "").trim(),
    mode,
    pinned,
  });
}

function parseDashboardFilter(raw, fallbackMode = "include", pinned = false) {
  let value = raw.trim();
  let mode = fallbackMode;
  if (value.startsWith("-")) {
    mode = "exclude";
    value = value.slice(1).trim();
  }

  let field = "all";
  const separatorIndex = value.search(/[:=]/);
  if (separatorIndex > 0) {
    const candidate = normalizeDashboardField(value.slice(0, separatorIndex));
    if (candidate) {
      field = candidate;
      value = value.slice(separatorIndex + 1).trim();
    }
  }

  value = stripFilterQuotes(value);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field,
    value,
    mode,
    pinned,
  };
}

function renderDashboardFilters() {
  if (!dashboardFilterChips) return;
  const events = filteredDashboardEvents();
  const metrics = dashboardMetrics(events);
  const active = state.dashboardQuery || state.dashboardFilters.length;
  const summary = active
    ? `${formatNumber.format(metrics.messages)} messages · ${formatNumber.format(metrics.domains)} domains`
    : `${formatNumber.format(metrics.messages)} messages`;

  dashboardFilterChips.innerHTML = `
    <span class="parsed-filter-count">${summary}</span>
    ${state.dashboardFilters
      .map((filter, index) => `
        <span class="parsed-filter-chip ${filter.mode} ${filter.pinned ? "pinned" : ""}">
          <button type="button" data-filter-action="pin" data-filter-index="${index}" title="${filter.pinned ? "Unpin filter" : "Pin filter"}" aria-label="${filter.pinned ? "Unpin filter" : "Pin filter"}">${filter.pinned ? "Pinned" : "Pin"}</button>
          <button type="button" data-filter-action="mode" data-filter-index="${index}" title="Toggle include or exclude" aria-label="Toggle include or exclude">${filter.mode === "exclude" ? "Exclude" : "Include"}</button>
          <strong>${escapeHtml(filter.field === "all" ? filter.value : `${filter.field}:${filter.value}`)}</strong>
          <button type="button" data-filter-action="remove" data-filter-index="${index}" title="Remove filter" aria-label="Remove filter">x</button>
        </span>
      `)
      .join("")}
  `;
}

function filteredDashboardEvents() {
  const events = state.events || [];
  if (!events.length) return [];
  const query = state.dashboardQuery.trim();
  const includeFilters = state.dashboardFilters.filter((filter) => filter.mode !== "exclude");
  const excludeFilters = state.dashboardFilters.filter((filter) => filter.mode === "exclude");
  return events.filter((event) => {
    if (query && !dashboardQueryMatches(event, query)) return false;
    if (includeFilters.length && !includeFilters.some((filter) => dashboardFilterMatches(event, filter))) {
      return false;
    }
    return excludeFilters.every((filter) => dashboardFilterMatches(event, filter));
  });
}

function dashboardQueryMatches(event, query) {
  const parsed = parseDashboardFilter(query, query.startsWith("-") ? "exclude" : "include", false);
  if (parsed.field !== "all" || query.startsWith("-")) {
    return dashboardFilterMatches(event, parsed);
  }
  return textIncludes(dashboardEventHaystack(event), query);
}

function dashboardFilterMatches(event, filter) {
  const matched = dashboardFieldValues(event, filter.field).some((value) => textIncludes(value, filter.value));
  return filter.mode === "exclude" ? !matched : matched;
}

function dashboardFieldValues(event, field) {
  if (field === "domain" || field === "header_from") return [event.header_from, event.domain];
  if (field === "source_ip" || field === "ip") return [event.source_ip];
  if (field === "reverse_dns" || field === "sender") return [event.reverse_dns, event.sender];
  if (field === "org" || field === "org_name" || field === "reporter") return [event.org_name];
  if (field === "disposition") return [event.disposition];
  if (field === "dkim") return [event.dkim, event.dkim_aligned > 0 ? "pass" : "fail"];
  if (field === "spf") return [event.spf, event.spf_aligned > 0 ? "pass" : "fail"];
  if (field === "country") return [event.country, event.country_code];
  if (field === "asn") return [event.asn_number ? `AS${event.asn_number}` : "", event.asn_organization];
  if (field === "report_id") return [event.report_id, event.report_uid];
  if (field === "date") return [event.date, event.begin, event.end];
  return dashboardEventHaystack(event);
}

function dashboardEventHaystack(event) {
  return [
    event.report_id,
    event.org_name,
    event.date,
    event.domain,
    event.header_from,
    event.source_ip,
    event.sender,
    event.reverse_dns,
    event.disposition,
    event.dkim,
    event.spf,
    event.country,
    event.country_code,
    event.city,
    event.continent,
    event.continent_code,
    event.asn_number ? `AS${event.asn_number}` : "",
    event.asn_organization,
  ];
}

function normalizeDashboardField(field) {
  const normalized = String(field || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    from: "header_from",
    header: "header_from",
    source: "source_ip",
    source_reverse_dns: "reverse_dns",
    reverse: "reverse_dns",
    rdns: "reverse_dns",
    organization: "org_name",
    reporting_org: "org_name",
    reporter: "org_name",
    disp: "disposition",
  };
  const allowed = new Set([
    "all",
    "domain",
    "header_from",
    "source_ip",
    "ip",
    "reverse_dns",
    "sender",
    "org",
    "org_name",
    "reporter",
    "disposition",
    "dkim",
    "spf",
    "country",
    "asn",
    "report_id",
    "date",
  ]);
  const fieldName = aliases[normalized] || normalized;
  return allowed.has(fieldName) ? fieldName : null;
}

function dashboardMetrics(events = filteredDashboardEvents()) {
  if (!events.length) {
    return {
      reports: 0,
      domains: 0,
      messages: 0,
      aligned: 0,
      dkim_aligned: 0,
      spf_aligned: 0,
      rejected: 0,
      quarantined: 0,
      compliance_rate: 0,
    };
  }

  const reports = new Set();
  const domains = new Set();
  const metrics = {
    reports: 0,
    domains: 0,
    messages: 0,
    aligned: 0,
    dkim_aligned: 0,
    spf_aligned: 0,
    rejected: 0,
    quarantined: 0,
    compliance_rate: 0,
  };

  for (const event of events) {
    reports.add(event.report_uid || event.report_id);
    domains.add(event.header_from || event.domain);
    metrics.messages += Number(event.messages || 0);
    metrics.aligned += Number(event.aligned || 0);
    metrics.dkim_aligned += Number(event.dkim_aligned || 0);
    metrics.spf_aligned += Number(event.spf_aligned || 0);
    if (event.disposition === "reject") metrics.rejected += Number(event.messages || 0);
    if (event.disposition === "quarantine") metrics.quarantined += Number(event.messages || 0);
  }

  metrics.reports = reports.size;
  metrics.domains = domains.size;
  metrics.compliance_rate = metrics.messages ? (metrics.aligned / metrics.messages) * 100 : 0;
  return metrics;
}

function dashboardScore(metrics) {
  if (!dashboardFilteringActive() && state.overview) return state.overview.score;
  return Math.round(metrics.compliance_rate || 0);
}

function dashboardGrade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

function dashboardTimelinePoints() {
  const rows = new Map();
  for (const event of filteredDashboardEvents()) {
    const key = event.date;
    const row = rows.get(key) || {
      date: key,
      messages: 0,
      aligned: 0,
      dkim_aligned: 0,
      spf_aligned: 0,
      rejected: 0,
      quarantined: 0,
    };
    row.messages += Number(event.messages || 0);
    row.aligned += Number(event.aligned || 0);
    row.dkim_aligned += Number(event.dkim_aligned || 0);
    row.spf_aligned += Number(event.spf_aligned || 0);
    if (event.disposition === "reject") row.rejected += Number(event.messages || 0);
    if (event.disposition === "quarantine") row.quarantined += Number(event.messages || 0);
    rows.set(key, row);
  }
  return [...rows.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
}

function dashboardSources() {
  const rows = new Map();
  for (const event of filteredDashboardEvents()) {
    const key = event.source_ip;
    const row = rows.get(key) || {
      source_ip: event.source_ip,
      sender: event.sender,
      reverse_dns: event.reverse_dns,
      messages: 0,
      aligned: 0,
      dkim_aligned: 0,
      spf_aligned: 0,
      rejected: 0,
      quarantined: 0,
      domains: new Set(),
      country: event.country,
      country_code: event.country_code,
      city: event.city,
      latitude: event.latitude,
      longitude: event.longitude,
      asn_number: event.asn_number,
      asn_organization: event.asn_organization,
    };
    row.messages += Number(event.messages || 0);
    row.aligned += Number(event.aligned || 0);
    row.dkim_aligned += Number(event.dkim_aligned || 0);
    row.spf_aligned += Number(event.spf_aligned || 0);
    if (event.disposition === "reject") row.rejected += Number(event.messages || 0);
    if (event.disposition === "quarantine") row.quarantined += Number(event.messages || 0);
    if (event.header_from || event.domain) row.domains.add(event.header_from || event.domain);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      domains: [...row.domains].sort(),
      alignment_rate: row.messages ? (row.aligned / row.messages) * 100 : 0,
    }))
    .sort((left, right) => right.messages - left.messages);
}

function dashboardDomains() {
  const rows = new Map();
  for (const event of filteredDashboardEvents()) {
    const key = event.header_from || event.domain || "unknown";
    const row = rows.get(key) || {
      domain: key,
      messages: 0,
      aligned: 0,
      sources: new Set(),
    };
    row.messages += Number(event.messages || 0);
    row.aligned += Number(event.aligned || 0);
    row.sources.add(event.source_ip);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      sources: row.sources.size,
    }))
    .sort((left, right) => right.messages - left.messages);
}

function dashboardReports() {
  const rows = new Map();
  for (const event of filteredDashboardEvents()) {
    const key = event.report_uid || event.report_id;
    const row = rows.get(key) || {
      id: key,
      org_name: event.org_name,
      report_id: event.report_id,
      domain: event.domain,
      messages: 0,
      domains: new Set(),
    };
    row.messages += Number(event.messages || 0);
    row.domains.add(event.header_from || event.domain);
    rows.set(key, row);
  }
  return [...rows.values()];
}

function dashboardGeoPoints() {
  const rows = dashboardSources()
    .filter((source) => Number.isFinite(Number(source.latitude)) && Number.isFinite(Number(source.longitude)))
    .map((source) => ({
      ...source,
      provider: "filtered events",
      risk: source.alignment_rate < 90 ? "high" : "low",
    }));
  if (rows.length || dashboardFilteringActive()) return rows;
  return state.geo.points || [];
}

function dashboardFilteringActive() {
  return Boolean(state.dashboardQuery.trim() || state.dashboardFilters.length);
}

function textIncludes(value, needle) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value || "");
  return text.toLowerCase().includes(String(needle || "").toLowerCase());
}

function stripFilterQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function loadDashboardFilters() {
  try {
    const filters = JSON.parse(localStorage.getItem("dmarcontrol-dashboard-filters") || "[]");
    return Array.isArray(filters)
      ? filters
          .filter((filter) => filter && filter.pinned && filter.value)
          .map((filter) => ({
            id: filter.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            field: normalizeDashboardField(filter.field) || "all",
            value: String(filter.value),
            mode: filter.mode === "exclude" ? "exclude" : "include",
            pinned: true,
          }))
      : [];
  } catch {
    return [];
  }
}

function saveDashboardFilters() {
  const pinned = state.dashboardFilters.filter((filter) => filter.pinned);
  localStorage.setItem("dmarcontrol-dashboard-filters", JSON.stringify(pinned));
}

function renderOverview() {
  const stats = dashboardMetrics();
  const score = dashboardScore(stats);
  setText("grade", dashboardGrade(score));
  setText("score", `${score}/100`);
  setText("score-detail", scoreDetailText(score, stats.compliance_rate));
  setText("metric-domains", formatNumber.format(stats.domains));
  setText("metric-reports", `${formatNumber.format(stats.reports)} reports`);
  setText("metric-messages", formatNumber.format(stats.messages));
  setText("metric-aligned", `${formatNumber.format(stats.aligned)} aligned`);
  setText("metric-alignment", `${stats.compliance_rate.toFixed(1)}%`);
  setText("metric-actions", `${state.actions.length} actions`);
  const scoreRing = document.getElementById("score-ring");
  scoreRing.style.setProperty("--score", score);
  scoreRing.style.setProperty("--score-color", scoreColor(score));
  renderKpiVisuals();
}

function renderKpiVisuals() {
  renderPolicyPostureVisual();
  renderScoreHistogramVisual();
}

function renderPolicyPostureVisual() {
  const target = document.getElementById("policy-posture-visual");
  if (!target) return;
  if (!state.domains.length) {
    target.innerHTML = `<div class="empty">No domain policy data yet.</div>`;
    return;
  }

  const policies = ["reject", "quarantine", "none", "unknown"];
  const counts = new Map(policies.map((policy) => [policy, 0]));
  state.domains.forEach((domain) => {
    const policy = policies.includes(domain.policy) ? domain.policy : "unknown";
    counts.set(policy, (counts.get(policy) || 0) + 1);
  });

  const total = state.domains.length || 1;
  let cursor = 0;
  const segments = policies
    .map((policy) => {
      const value = counts.get(policy) || 0;
      if (!value) return "";
      const start = cursor;
      cursor += (value / total) * 100;
      return `${policyChartColor(policy)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    })
    .filter(Boolean)
    .join(", ");
  const rejectCount = counts.get("reject") || 0;
  const readyCount = rejectCount + (counts.get("quarantine") || 0);

  target.innerHTML = `
    <div class="policy-donut-wrap">
      <div class="policy-donut" style="--policy-donut: ${segments || "var(--dm-line) 0% 100%"}" role="img" aria-label="Policy posture distribution">
        <span>${Math.round((readyCount / total) * 100)}%</span>
        <small>enforced</small>
      </div>
      <div class="policy-donut-legend">
        ${policies
          .map((policy) => `
            <button class="policy-legend-item" type="button" data-policy-detail="${escapeHtml(policy)}" aria-label="Show ${escapeHtml(policy)} policy domains">
              <i style="background: ${policyChartColor(policy)}"></i>
              <span>${escapeHtml(policy)}</span>
              <strong>${formatNumber.format(counts.get(policy) || 0)}</strong>
            </button>
          `)
          .join("")}
      </div>
    </div>
  `;

  target.querySelectorAll("[data-policy-detail]").forEach((button) => {
    button.addEventListener("click", () => openPolicyModal(button.dataset.policyDetail));
  });
}

function renderScoreHistogramVisual() {
  const target = document.getElementById("score-histogram-visual");
  if (!target) return;
  if (!state.domains.length) {
    target.innerHTML = `<div class="empty">No score distribution yet.</div>`;
    return;
  }

  const bins = [
    { label: "0-49", detail: "Critical", min: 0, max: 49, status: "bad" },
    { label: "50-69", detail: "Needs work", min: 50, max: 69, status: "warn" },
    { label: "70-89", detail: "Close", min: 70, max: 89, status: "ok" },
    { label: "90-100", detail: "Healthy", min: 90, max: 100, status: "good" },
  ].map((bin) => ({
    ...bin,
    domains: state.domains
      .filter((domain) => Number(domain.score || 0) >= bin.min && Number(domain.score || 0) <= bin.max)
      .sort((left, right) => Number(right.messages || 0) - Number(left.messages || 0)),
  }));
  const maxCount = Math.max(...bins.map((bin) => bin.domains.length), 1);

  target.innerHTML = `
    <div class="score-distribution-list" aria-label="Domain score distribution">
      ${bins
        .map((bin, index) => {
          const width = Math.max(3, (bin.domains.length / maxCount) * 100);
          return `
            <button class="score-range-row ${bin.status}" type="button" data-score-bin="${index}" aria-label="Open ${escapeHtml(bin.detail)} score range details">
              <div class="score-range-head">
                <span>${escapeHtml(bin.detail)}</span>
                <strong>${escapeHtml(bin.label)}</strong>
              </div>
              <div class="score-range-count">
                <strong>${formatNumber.format(bin.domains.length)}</strong>
                <span>${bin.domains.length === 1 ? "domain" : "domains"}</span>
              </div>
              <div class="score-range-bar" aria-hidden="true">
                <i style="width: ${width}%"></i>
              </div>
              <div class="score-range-action">
                <span>View details</span>
              </div>
            </button>
          `;
        })
        .join("")}
    </div>
  `;

  target.querySelectorAll("[data-score-bin]").forEach((button) => {
    button.addEventListener("click", () => openScoreModal(bins[Number(button.dataset.scoreBin)]));
  });
}

function openScoreModal(bin) {
  if (!bin) return;
  const modal = document.getElementById("score-detail-modal");
  const title = document.getElementById("score-modal-title");
  const body = document.getElementById("score-modal-body");
  title.textContent = `${bin.detail} · ${bin.label}`;
  body.innerHTML = renderScoreRangeDetail(bin);
  modal.hidden = false;
  document.body.classList.add("modal-open");

  body.querySelectorAll("[data-score-domain]").forEach((button) => {
    button.addEventListener("click", () => {
      closeScoreModal();
      openDomainModal(button.dataset.scoreDomain);
    });
  });
}

function closeScoreModal() {
  const modal = document.getElementById("score-detail-modal");
  if (!modal) return;
  modal.hidden = true;
  if (
    document.getElementById("domain-detail-modal")?.hidden &&
    document.getElementById("protocol-detail-modal")?.hidden &&
    document.getElementById("source-detail-modal")?.hidden &&
    document.getElementById("action-detail-modal")?.hidden &&
    document.getElementById("policy-detail-modal")?.hidden
  ) {
    document.body.classList.remove("modal-open");
  }
}

function openPolicyModal(policy) {
  const modal = document.getElementById("policy-detail-modal");
  const title = document.getElementById("policy-modal-title");
  const body = document.getElementById("policy-modal-body");
  if (!modal || !title || !body) return;

  const normalizedPolicy = ["reject", "quarantine", "none"].includes(policy) ? policy : "unknown";
  const domains = state.domains
    .filter((domain) => {
      const domainPolicy = ["reject", "quarantine", "none"].includes(domain.policy) ? domain.policy : "unknown";
      return domainPolicy === normalizedPolicy;
    })
    .sort((left, right) => Number(right.messages || 0) - Number(left.messages || 0) || left.domain.localeCompare(right.domain));

  title.textContent = `p=${normalizedPolicy}`;
  body.innerHTML = renderPolicyDetail(normalizedPolicy, domains);
  modal.hidden = false;
  document.body.classList.add("modal-open");

  body.querySelectorAll("[data-policy-domain]").forEach((button) => {
    button.addEventListener("click", () => {
      closePolicyModal();
      openDomainModal(button.dataset.policyDomain);
    });
  });
}

function closePolicyModal() {
  const modal = document.getElementById("policy-detail-modal");
  if (!modal) return;
  modal.hidden = true;
  if (
    document.getElementById("domain-detail-modal")?.hidden &&
    document.getElementById("protocol-detail-modal")?.hidden &&
    document.getElementById("source-detail-modal")?.hidden &&
    document.getElementById("action-detail-modal")?.hidden &&
    document.getElementById("score-detail-modal")?.hidden
  ) {
    document.body.classList.remove("modal-open");
  }
}

function renderPolicyDetail(policy, domains) {
  if (!domains.length) {
    return `<div class="empty">No domains currently use this policy.</div>`;
  }

  const messages = domains.reduce((sum, domain) => sum + Number(domain.messages || 0), 0);
  const aligned = domains.reduce((sum, domain) => sum + Number(domain.aligned || 0), 0);
  const alignment = messages === 0 ? 0 : (aligned / messages) * 100;
  const status = domainPolicyStatus(policy);

  return `
    <div class="score-modal-summary ${status}">
      <span>${escapeHtml(domainPolicyTooltip(policy))}</span>
      <strong>${formatNumber.format(domains.length)} ${domains.length === 1 ? "domain" : "domains"}</strong>
      <p>${formatNumber.format(messages)} messages · ${alignment.toFixed(1)}% aligned</p>
    </div>
    <div class="table-responsive">
      <table class="table table-sm align-middle score-domain-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th class="text-end">Score</th>
            <th class="text-end">Messages</th>
            <th class="text-end">Alignment</th>
            <th class="text-end">Sources</th>
            <th>Next step</th>
          </tr>
        </thead>
        <tbody>
          ${domains
            .map((domain) => {
              const domainAlignment = domain.messages === 0 ? 0 : (domain.aligned / domain.messages) * 100;
              return `
                <tr>
                  <td>
                    <button class="score-domain-link" type="button" data-policy-domain="${escapeHtml(domain.domain)}">${escapeHtml(domain.domain)}</button>
                  </td>
                  <td class="text-end"><span class="status-badge grade ${domainGradeStatus(domain.score)}">${Number(domain.score || 0)}/100</span></td>
                  <td class="text-end">${formatNumber.format(domain.messages || 0)}</td>
                  <td class="text-end">${domainAlignment.toFixed(1)}%</td>
                  <td class="text-end">${formatNumber.format(domain.sources || 0)}</td>
                  <td>${escapeHtml(domain.next_step)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderScoreRangeDetail(bin) {
  if (!bin.domains.length) {
    return `<div class="empty">No domains in this score range.</div>`;
  }

  return `
    <div class="score-modal-summary ${bin.status}">
      <span>${escapeHtml(bin.detail)}</span>
      <strong>${formatNumber.format(bin.domains.length)} ${bin.domains.length === 1 ? "domain" : "domains"}</strong>
      <p>Scores from ${escapeHtml(bin.label)}. Domains are sorted by message volume.</p>
    </div>
    <div class="table-responsive">
      <table class="table table-sm align-middle score-domain-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Policy</th>
            <th class="text-end">Score</th>
            <th class="text-end">Messages</th>
            <th class="text-end">Alignment</th>
            <th>Next step</th>
          </tr>
        </thead>
        <tbody>
          ${bin.domains
            .map((domain) => {
              const alignment = domain.messages === 0 ? 0 : (domain.aligned / domain.messages) * 100;
              return `
                <tr>
                  <td>
                    <button class="score-domain-link" type="button" data-score-domain="${escapeHtml(domain.domain)}">${escapeHtml(domain.domain)}</button>
                  </td>
                  <td><span class="status-badge policy ${domainPolicyStatus(domain.policy)}">${escapeHtml(domain.policy)}</span></td>
                  <td class="text-end"><span class="status-badge grade ${domainGradeStatus(domain.score)}">${Number(domain.score || 0)}/100</span></td>
                  <td class="text-end">${formatNumber.format(domain.messages || 0)}</td>
                  <td class="text-end">${alignment.toFixed(1)}%</td>
                  <td>${escapeHtml(domain.next_step)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function policyChartColor(policy) {
  if (policy === "reject") return "var(--dm-success)";
  if (policy === "quarantine") return "var(--dm-warning)";
  if (policy === "none") return "var(--dm-danger)";
  return "var(--dm-muted)";
}

function scoreDetailText(score, complianceRate) {
  if (score === 0) return "No imported reports yet.";
  return `${score}/100 score · ${complianceRate.toFixed(1)}% alignment`;
}

function scoreColor(score) {
  if (score >= 90) return "var(--dm-success)";
  if (score >= 70) return "var(--dm-warning)";
  return "var(--dm-danger)";
}

function renderTrend() {
  const trend = document.getElementById("trend");
  trend.innerHTML = "";
  if (!state.timeline.length) {
    trend.classList.add("trend-empty-state");
    trend.innerHTML = `<div class="empty trend-empty">No report history yet.</div>`;
    return;
  }
  trend.classList.remove("trend-empty-state");

  const points = filteredTrendPoints();
  if (!points.length) {
    trend.classList.add("trend-empty-state");
    trend.innerHTML = `<div class="empty trend-empty">No report history in this range.</div>`;
    return;
  }

  const max = Math.max(...points.map((point) => point.messages), 1);
  const messagePoints = trendPoints(points, max, "messages");
  const alignedPoints = trendPoints(points, max, "aligned");
  const lastMessagePoint = messagePoints[messagePoints.length - 1];
  const areaPath = `${linePath(messagePoints)} L ${lastMessagePoint.x} 220 L ${messagePoints[0].x} 220 Z`;
  const labels = trendLabels(points);

  trend.innerHTML = `
    <div class="trend-graph">
      <svg viewBox="0 0 640 260" preserveAspectRatio="none" role="img" aria-label="Compliance trend chart">
        <g class="trend-grid">
          <path d="M34 22 H624" />
          <path d="M34 88 H624" />
          <path d="M34 154 H624" />
          <path d="M34 220 H624" />
        </g>
        <path class="trend-area" d="${areaPath}" />
        <path class="trend-line trend-line-total" d="${linePath(messagePoints)}" />
        <path class="trend-line trend-line-aligned" d="${linePath(alignedPoints)}" />
        ${messagePoints
          .map((point, index) => {
            const source = points[index];
            const aligned = Number(source.aligned || 0);
            const messages = Number(source.messages || 0);
            const rate = messages ? (aligned / messages) * 100 : 0;
            const detail = `Messages · ${shortDate(source.date)} · ${formatNumber.format(messages)} total · ${formatNumber.format(aligned)} aligned · ${rate.toFixed(1)}% pass`;
            return `
              <circle class="trend-hitpoint" cx="${point.x}" cy="${point.y}" r="10" tabindex="0" data-tooltip="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}"></circle>
              <circle class="trend-point trend-point-total" cx="${point.x}" cy="${point.y}" r="3.7" aria-hidden="true"></circle>
            `;
          })
          .join("")}
        ${alignedPoints
          .map((point, index) => {
            const source = points[index];
            const aligned = Number(source.aligned || 0);
            const messages = Number(source.messages || 0);
            const rate = messages ? (aligned / messages) * 100 : 0;
            const detail = `Aligned · ${shortDate(source.date)} · ${formatNumber.format(aligned)} aligned · ${formatNumber.format(messages)} total · ${rate.toFixed(1)}% pass`;
            return `
              <circle class="trend-hitpoint trend-hitpoint-aligned" cx="${point.x}" cy="${point.y}" r="10" tabindex="0" data-tooltip="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}"></circle>
              <circle class="trend-point trend-point-aligned" cx="${point.x}" cy="${point.y}" r="3.4" aria-hidden="true"></circle>
            `;
          })
          .join("")}
        ${labels
          .map((point) => {
            const index = points.indexOf(point);
            const edgeClass = index === 0 ? " trend-label-start" : index === points.length - 1 ? " trend-label-end" : "";
            return `<text class="trend-label${edgeClass}" x="${messagePoints[index].x}" y="244">${escapeHtml(shortDate(point.date))}</text>`;
          })
          .join("")}
      </svg>
      <div class="trend-legend">
        <span><i class="total"></i>Messages</span>
        <span><i class="aligned"></i>Aligned</span>
      </div>
    </div>
  `;
}

function renderParsedmarcDashboard() {
  renderParsedAlignmentKpis();
  renderParsedMiniCharts();
  renderParsedReportingOrganizations();
  renderParsedReverseDns();
  renderParsedHeaderFrom();
  renderParsedSourceIps();
  renderParsedAlignmentDetails();
  renderParsedReverseDnsEvolution();
}

function renderParsedAlignmentKpis() {
  const stats = dashboardMetrics();
  const messages = Number(stats.messages || 0);
  const spfRate = messages ? (Number(stats.spf_aligned || 0) / messages) * 100 : 0;
  const dkimRate = messages ? (Number(stats.dkim_aligned || 0) / messages) * 100 : 0;
  renderParsedKpi("parsed-spf-alignment", spfRate, Number(stats.spf_aligned || 0), messages);
  renderParsedKpi("parsed-dkim-alignment", dkimRate, Number(stats.dkim_aligned || 0), messages);
  renderParsedKpi("parsed-dmarc-passage", Number(stats.compliance_rate || 0), Number(stats.aligned || 0), messages);
}

function renderParsedKpi(id, rate, passed, total) {
  const target = document.getElementById(id);
  if (!target) return;
  if (!total) {
    target.innerHTML = `<div class="parsed-empty">No results found</div>`;
    return;
  }

  const failed = Math.max(0, total - passed);
  const safeRate = Math.max(0, Math.min(100, Number(rate || 0)));
  const status = parsedRateStatus(safeRate);
  const tooltip = `${safeRate.toFixed(1)}% pass · ${formatNumber.format(passed)} pass · ${formatNumber.format(failed)} fail · ${formatNumber.format(total)} total`;
  target.innerHTML = `
    <div class="parsed-donut ${status}" style="--donut-value: ${safeRate}" tabindex="0" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">
      <span>${safeRate.toFixed(1)}%</span>
      <small>pass</small>
    </div>
    <dl>
      <div><dt>pass</dt><dd>${formatNumber.format(passed)}</dd></div>
      <div><dt>fail</dt><dd>${formatNumber.format(failed)}</dd></div>
      <div><dt>total</dt><dd>${formatNumber.format(total)}</dd></div>
    </dl>
  `;
}

function parsedProtocolScore(name) {
  const protocol = (state.overview?.protocols || []).find((item) => item.name === name);
  return Number(protocol?.score || 0);
}

function parsedProtocolAligned(name) {
  const protocol = (state.overview?.protocols || []).find((item) => item.name === name);
  const metric = (protocol?.metrics || []).find((item) => item.label.toLowerCase().includes("aligned"));
  const value = String(metric?.value || "0").replace(/[^\d.-]/g, "");
  return Number(value || 0);
}

function renderParsedMiniCharts() {
  renderParsedAlignmentChart("parsed-spf-trend", "spf_aligned", "SPF");
  renderParsedAlignmentChart("parsed-dkim-trend", "dkim_aligned", "DKIM");
  renderParsedDispositionChart();
}

function renderParsedAlignmentChart(id, key, label) {
  const target = document.getElementById(id);
  if (!target) return;
  const points = filteredTrendPoints();
  if (!points.length) {
    target.innerHTML = `<div class="parsed-empty">No results found</div>`;
    return;
  }

  const values = points.map((point) => ({
    date: point.date,
    value: point.messages ? (Number(point[key] || 0) / Number(point.messages || 1)) * 100 : 0,
    messages: point.messages,
  }));
  const chartPoints = miniChartPoints(values.map((point) => point.value), 100);
  const areaPath = miniAreaPath(chartPoints);
  const line = linePath(chartPoints);

  target.innerHTML = `
    <svg viewBox="0 0 320 150" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)} alignment over time">
      <g class="parsed-chart-grid">
        <path d="M28 18 H306" />
        <path d="M28 66 H306" />
        <path d="M28 114 H306" />
      </g>
      <g class="parsed-chart-axis">
        <text x="10" y="22">100</text>
        <text x="16" y="118">0</text>
      </g>
      <path class="parsed-mini-area" d="${areaPath}" />
      <path class="parsed-mini-line" d="${line}" />
      ${chartPoints.map((point, index) => {
        const detail = `${label} · ${shortDate(values[index].date)} · ${values[index].value.toFixed(1)}% · ${formatNumber.format(values[index].messages)} messages`;
        return `
          <circle class="parsed-mini-hitpoint" cx="${point.x}" cy="${point.y}" r="9" tabindex="0" data-tooltip="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}"></circle>
          <circle class="parsed-mini-point" cx="${point.x}" cy="${point.y}" r="3.8" aria-hidden="true"></circle>
        `;
      }).join("")}
    </svg>
    <div class="parsed-chart-foot">
      <span>${escapeHtml(shortDate(values[0].date))}</span>
      <strong>${values[values.length - 1].value.toFixed(1)}%</strong>
      <span>${escapeHtml(shortDate(values[values.length - 1].date))}</span>
    </div>
  `;
}

function renderParsedDispositionChart() {
  const target = document.getElementById("parsed-disposition-trend");
  if (!target) return;
  const points = filteredTrendPoints();
  if (!points.length) {
    target.innerHTML = `<div class="parsed-empty">No results found</div>`;
    return;
  }

  const max = Math.max(...points.map((point) => Number(point.messages || 0)), 1);
  target.innerHTML = `
    <div class="parsed-disposition-bars">
      ${points
        .map((point) => {
          const rejected = Number(point.rejected || 0);
          const quarantined = Number(point.quarantined || 0);
          const none = Math.max(0, Number(point.messages || 0) - rejected - quarantined);
          const height = Math.max(5, (Number(point.messages || 0) / max) * 100);
          const detail = `${shortDate(point.date)} · ${formatNumber.format(point.messages)} messages · none ${formatNumber.format(none)} · quarantine ${formatNumber.format(quarantined)} · reject ${formatNumber.format(rejected)}`;
          return `
            <div class="parsed-disposition-bar" style="height: ${height}%" tabindex="0" data-tooltip="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}">
              <i class="none" style="height: ${(none / Math.max(point.messages, 1)) * 100}%"></i>
              <i class="quarantine" style="height: ${(quarantined / Math.max(point.messages, 1)) * 100}%"></i>
              <i class="reject" style="height: ${(rejected / Math.max(point.messages, 1)) * 100}%"></i>
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="parsed-legend"><span><i class="none"></i>none</span><span><i class="quarantine"></i>quarantine</span><span><i class="reject"></i>reject</span></div>
  `;
}

function renderParsedReportingOrganizations() {
  const rows = aggregateBy(dashboardReports(), (report) => report.org_name || "Unknown reporter");
  const values = [...rows.values()]
    .sort((left, right) => right.messages - left.messages)
    .slice(0, 12);
  renderParsedList("parsed-reporting-orgs", values, (row) => `
    <div>
      <strong>${escapeHtml(row.label)}</strong>
      <small>${formatNumber.format(row.count)} reports · ${formatNumber.format(row.domains.size)} domains</small>
    </div>
    <span>${formatNumber.format(row.messages)}</span>
  `);
}

function renderParsedReverseDns() {
  const rows = aggregateSourcesByReverseDns().slice(0, 2000);
  renderParsedTable("parsed-reverse-dns", ["source_reverse_DNS", "IPs", "Domains", "Messages", "DMARC"], rows, (row) => [
    `<strong>${escapeHtml(row.label)}</strong>`,
    formatNumber.format(row.sourceCount),
    formatNumber.format(row.domains.size),
    formatNumber.format(row.messages),
    `${row.alignmentRate.toFixed(1)}%`,
  ], (row) => ({ field: "reverse_dns", value: row.label }));
}

function renderParsedHeaderFrom() {
  const rows = dashboardDomains()
    .sort((left, right) => Number(right.messages || 0) - Number(left.messages || 0))
    .slice(0, 12)
    .map((domain) => ({
      label: domain.domain,
      messages: Number(domain.messages || 0),
      detail: `${formatNumber.format(domain.sources || 0)} sources · ${domain.messages ? ((domain.aligned / domain.messages) * 100).toFixed(1) : "0.0"}% DMARC`,
    }));
  renderParsedList("parsed-header-from", rows, (row) => `
    <div>
      <strong>${escapeHtml(row.label)}</strong>
      <small>${escapeHtml(row.detail)}</small>
    </div>
    <span>${formatNumber.format(row.messages)}</span>
  `);
}

function renderParsedSourceIps() {
  const rows = dashboardSources()
    .sort((left, right) => Number(right.messages || 0) - Number(left.messages || 0))
    .slice(0, 1000);
  renderParsedTable("parsed-source-ips", ["IP address", "Reverse DNS", "Country", "Messages", "Disposition"], rows, (source) => {
    const point = geoPointForIp(source.source_ip);
    return [
      `<strong>${sourceIpWithFlag(source.source_ip)}</strong>`,
      escapeHtml(reverseDnsLabel(source)),
      escapeHtml(point ? formatGeoLocation(point) : "Unknown"),
      formatNumber.format(source.messages || 0),
      `${formatNumber.format(source.rejected || 0)} rejected · ${formatNumber.format(source.quarantined || 0)} quarantined`,
    ];
  }, (source) => ({ field: "source_ip", value: source.source_ip }));
}

function renderParsedAlignmentDetails() {
  renderParsedProtocolDetails("parsed-spf-details", "spf_aligned", "SPF");
  renderParsedProtocolDetails("parsed-dkim-details", "dkim_aligned", "DKIM");
}

function renderParsedProtocolDetails(id, key, label) {
  const rows = dashboardSources()
    .map((source) => {
      const passed = Number(source[key] || 0);
      const messages = Number(source.messages || 0);
      return {
        ...source,
        passed,
        failed: Math.max(0, messages - passed),
        rate: messages ? (passed / messages) * 100 : 0,
      };
    })
    .sort((left, right) => left.rate - right.rate || right.messages - left.messages)
    .slice(0, 1000);
  renderParsedTable(id, ["Source", `${label} pass`, `${label} fail`, "Rate"], rows, (source) => [
    `<strong>${escapeHtml(reverseDnsLabel(source))}</strong><small>${escapeHtml(source.source_ip)}</small>`,
    formatNumber.format(source.passed),
    formatNumber.format(source.failed),
    `${source.rate.toFixed(1)}%`,
  ], (source) => ({ field: "source_ip", value: source.source_ip }));
}

function renderParsedReverseDnsEvolution() {
  const rows = aggregateSourcesByReverseDns().slice(0, 2000);
  renderParsedTable("parsed-reverse-dns-trend", ["source_reverse_DNS", "Messages", "Aligned", "DMARC passage"], rows, (row) => [
    `<strong>${escapeHtml(row.label)}</strong>`,
    formatNumber.format(row.messages),
    formatNumber.format(row.aligned),
    `<span class="parsed-rate ${parsedRateStatus(row.alignmentRate)}">${row.alignmentRate.toFixed(1)}%</span>`,
  ], (row) => ({ field: "reverse_dns", value: row.label }));
}

function aggregateSourcesByReverseDns() {
  const rows = new Map();
  for (const source of dashboardSources()) {
    const label = reverseDnsLabel(source);
    const row = rows.get(label) || {
      label,
      sourceCount: 0,
      messages: 0,
      aligned: 0,
      rejected: 0,
      quarantined: 0,
      domains: new Set(),
    };
    row.sourceCount += 1;
    row.messages += Number(source.messages || 0);
    row.aligned += Number(source.aligned || 0);
    row.rejected += Number(source.rejected || 0);
    row.quarantined += Number(source.quarantined || 0);
    for (const domain of source.domains || []) row.domains.add(domain);
    rows.set(label, row);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      alignmentRate: row.messages ? (row.aligned / row.messages) * 100 : 0,
    }))
    .sort((left, right) => right.messages - left.messages);
}

function aggregateBy(items, keyFn) {
  const rows = new Map();
  for (const item of items || []) {
    const label = keyFn(item);
    const row = rows.get(label) || { label, count: 0, messages: 0, domains: new Set() };
    row.count += 1;
    row.messages += Number(item.messages || 0);
    if (item.domains instanceof Set) {
      for (const domain of item.domains) row.domains.add(domain);
    }
    if (item.domain) row.domains.add(item.domain);
    rows.set(label, row);
  }
  return rows;
}

function renderParsedList(id, rows, rowTemplate) {
  const target = document.getElementById(id);
  if (!target) return;
  if (!rows.length) {
    target.innerHTML = `<div class="parsed-empty">No results found</div>`;
    return;
  }
  target.innerHTML = rows.map((row) => `<article>${rowTemplate(row)}</article>`).join("");
}

function renderParsedTable(id, columns, rows, rowCells, rowFilter = null) {
  const target = document.getElementById(id);
  if (!target) return;
  if (!rows.length) {
    target.innerHTML = `<div class="parsed-empty">No results found</div>`;
    return;
  }
  const filters = rowFilter ? rows.map((row) => rowFilter(row)) : [];
  target.innerHTML = `
    <table class="parsed-table">
      <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows
          .map((row, index) => {
            const filter = filters[index];
            const clickable = filter?.value ? ` class="parsed-clickable-row" tabindex="0" role="button" data-row-filter-index="${index}" aria-label="Filter by ${escapeHtml(filter.field)} ${escapeHtml(filter.value)}"` : "";
            return `<tr${clickable}>${rowCells(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;

  if (!rowFilter) return;
  target.querySelectorAll("[data-row-filter-index]").forEach((row) => {
    const applyRowFilter = () => {
      const filter = filters[Number(row.dataset.rowFilterIndex)];
      if (!filter?.value) return;
      addDashboardFilterValue(filter.field, filter.value, filter.mode || "include", Boolean(filter.pinned));
    };
    row.addEventListener("click", applyRowFilter);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        applyRowFilter();
      }
    });
  });
}

function miniChartPoints(values, max) {
  const width = 278;
  const left = 28;
  const top = 18;
  const height = 96;
  const safeMax = Math.max(max, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((value, index) => ({
    x: left + step * index,
    y: top + height - (Number(value || 0) / safeMax) * height,
  }));
}

function miniAreaPath(points) {
  if (!points.length) return "";
  return `${linePath(points)} L ${points[points.length - 1].x} 130 L ${points[0].x} 130 Z`;
}

function reverseDnsLabel(source) {
  const sender = String(source.sender || "").trim();
  if (sender && sender !== "Unknown sender") return sender;
  return source.source_ip || "Unknown source";
}

function parsedRateStatus(rate) {
  if (rate >= 98) return "good";
  if (rate >= 90) return "warn";
  return "bad";
}

function renderTrendRange() {
  document.querySelectorAll("[data-trend-range]").forEach((button) => {
    const active = button.dataset.trendRange === state.trendRange;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function filteredTrendPoints() {
  const days = Number(state.trendRange.replace("d", "")) || 1;
  const points = dashboardTimelinePoints()
    .map((point) => ({ ...point, timestamp: Date.parse(point.date) }))
    .filter((point) => Number.isFinite(point.timestamp));
  if (!points.length) return [];

  const latest = Math.max(...points.map((point) => point.timestamp));
  const start = latest - (days - 1) * 24 * 60 * 60 * 1000;
  return points.filter((point) => point.timestamp >= start);
}

function trendLabels(points) {
  const interval = Math.max(1, Math.ceil(points.length / 6));
  return points.filter((_, index) => index === 0 || index === points.length - 1 || index % interval === 0);
}

function trendPoints(points, max, key) {
  const width = 590;
  const left = 34;
  const top = 22;
  const height = 198;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  return points.map((point, index) => ({
    x: left + step * index,
    y: top + height - (Number(point[key] || 0) / max) * height,
  }));
}

function linePath(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function renderProtocols() {
  const list = document.getElementById("protocols");
  list.innerHTML = state.overview.protocols
    .map(
      (protocol, index) => `
      <button class="list-group-item protocol-item" type="button" data-protocol-index="${index}">
        <span class="protocol-dot ${protocolClass(protocol.status)}" aria-hidden="true"></span>
        <div class="protocol-content">
          <div class="protocol-heading">
            <strong>${escapeHtml(protocol.name)}</strong>
            <span class="protocol-score">${Number(protocol.score || 0)}%</span>
          </div>
          <small>${escapeHtml(protocol.status)} · ${escapeHtml(protocol.detail)}</small>
          <div class="protocol-progress" aria-hidden="true"><i style="width: ${Math.max(3, Number(protocol.score || 0))}%"></i></div>
          <div class="protocol-mini">
            ${(protocol.metrics || [])
              .slice(0, 2)
              .map((metric) => `<span>${escapeHtml(metric.label)} <strong>${escapeHtml(metric.value)}</strong></span>`)
              .join("")}
          </div>
        </div>
      </button>
    `,
    )
    .join("");

  list.querySelectorAll("[data-protocol-index]").forEach((button) => {
    button.addEventListener("click", () => openProtocolModal(Number(button.dataset.protocolIndex)));
  });
}

function renderGeoMap() {
  const map = document.getElementById("geo-map");
  const list = document.getElementById("geo-list");
  const points = dashboardGeoPoints();
  const max = Math.max(...points.map((point) => point.messages), 1);
  const visible = points
    .filter((point) => Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)))
    .slice(0, 250);

  if (!window.L) {
    map.innerHTML = `<div class="empty">Interactive map assets are unavailable.</div>`;
    renderGeoList(list, points);
    return;
  }

  if (!geoMapInstance) {
    geoMapInstance = window.L.map(map, {
      scrollWheelZoom: false,
      worldCopyJump: true,
    }).setView([35, 0], 2);

    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(geoMapInstance);

    geoLayerGroup = window.L.layerGroup().addTo(geoMapInstance);
  }

  geoLayerGroup.clearLayers();
  const bounds = [];

  for (const point of visible) {
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    const radius = Math.max(7, Math.min(24, Math.sqrt(point.messages / max) * 24));
    const color = point.risk === "critical" || point.risk === "high" ? "#c03221" : "#3a57e8";
    const marker = window.L.circleMarker([latitude, longitude], {
      radius,
      color: "#ffffff",
      weight: 2,
      fillColor: color,
      fillOpacity: 0.76,
    }).bindPopup(`
      <strong>${escapeHtml(point.sender)}</strong><br>
      ${countryFlag(point.country_code)} ${escapeHtml(point.source_ip)}<br>
      ${formatNumber.format(point.messages)} messages<br>
      ${escapeHtml(formatGeoLocation(point))}<br>
      ${escapeHtml(formatGeoAsn(point))}
    `);

    marker.addTo(geoLayerGroup);
    bounds.push([latitude, longitude]);
  }

  if (bounds.length) {
    geoMapInstance.fitBounds(window.L.latLngBounds(bounds).pad(0.3), { maxZoom: 5 });
  } else {
    geoMapInstance.setView([35, 0], 2);
  }

  setTimeout(() => geoMapInstance.invalidateSize(), 0);
  renderGeoList(list, points);
}

function renderGeoList(list, points) {
  if (!points.length) {
    list.innerHTML = `<div class="empty">No geolocated source IPs yet.</div>`;
    return;
  }

  list.innerHTML = aggregateGeoLocations(points)
    .slice(0, 8)
    .map(
      (item) => `
        <div class="list-group-item">
          <div class="d-flex justify-content-between gap-3">
            <div>
              <strong>${countryFlag(item.country_code)} ${escapeHtml(formatGeoLocation(item))}</strong>
              <small class="text-muted d-block">${item.sources} sources</small>
            </div>
            <span class="fw-bold">${formatNumber.format(item.messages)}</span>
          </div>
        </div>
      `,
    )
    .join("");
}

function aggregateGeoLocations(points) {
  const rows = new Map();
  for (const point of points) {
    const key = `${point.city}|${point.country}`;
    const row = rows.get(key) || {
      city: point.city,
      country: point.country,
      country_code: point.country_code,
      messages: 0,
      sources: 0,
    };
    row.messages += point.messages;
    row.sources += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((left, right) => right.messages - left.messages);
}

function formatGeoLocation(point) {
  if (!point.city || point.city === "Country-level" || point.city === point.country) {
    return point.country_code ? `${point.country} (${point.country_code})` : point.country;
  }
  return `${point.city}, ${point.country}`;
}

function formatGeoAsn(point) {
  if (point.asn_number && point.asn_organization) {
    return `AS${point.asn_number} · ${point.asn_organization}`;
  }
  if (point.asn_number) return `AS${point.asn_number}`;
  return "ASN unavailable";
}

function renderDomains() {
  const body = document.getElementById("domains-body");
  const pagination = document.getElementById("domains-pagination");
  const summary = document.getElementById("domains-page-summary");
  if (!state.domains.length) {
    body.innerHTML = `<tr><td colspan="6">No domains found in imported reports.</td></tr>`;
    pagination.innerHTML = "";
    summary.textContent = "";
    return;
  }

  const domains = sortedDomains();
  if (!domains.length) {
    body.innerHTML = `<tr><td colspan="6">No domains match this search.</td></tr>`;
    pagination.innerHTML = "";
    summary.textContent = `0 of ${formatNumber.format(state.domains.length)} domains`;
    renderDomainSortState();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(domains.length / state.domainsPerPage));
  state.domainPage = Math.min(Math.max(1, state.domainPage), totalPages);
  const start = (state.domainPage - 1) * state.domainsPerPage;
  const page = domains.slice(start, start + state.domainsPerPage);
  renderDomainSortState();

  body.innerHTML = page
    .map((domain) => {
      const alignment = domain.messages === 0 ? 0 : (domain.aligned / domain.messages) * 100;
      const gradeTooltip = domainGradeTooltip(domain, alignment);
      const policyTooltip = domainPolicyTooltip(domain.policy);
      return `
        <tr class="domain-row" tabindex="0" data-domain="${escapeHtml(domain.domain)}" aria-label="Open ${escapeHtml(domain.domain)} details">
          <td>
            <span class="domain-name-cell">
              <span class="domain-row-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" focusable="false">
                  <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
                  <path d="M3.6 9h16.8" />
                  <path d="M3.6 15h16.8" />
                  <path d="M12 3c2.2 2.4 3.2 5.4 3.2 9s-1 6.6-3.2 9" />
                  <path d="M12 3c-2.2 2.4-3.2 5.4-3.2 9s1 6.6 3.2 9" />
                </svg>
              </span>
              <span>
                <strong>${escapeHtml(domain.domain)}</strong>
                <small>(${domain.sources} sources)</small>
              </span>
            </span>
          </td>
          <td>
            <span class="status-badge grade ${domainGradeStatus(domain.score)}" tabindex="0" data-tooltip="${escapeHtml(gradeTooltip)}" aria-label="${escapeHtml(gradeTooltip)}">
              ${escapeHtml(domain.grade)}
            </span>
          </td>
          <td>
            <span class="status-badge policy ${domainPolicyStatus(domain.policy)}" tabindex="0" data-tooltip="${escapeHtml(policyTooltip)}" aria-label="${escapeHtml(policyTooltip)}">
              ${escapeHtml(domain.policy)}
            </span>
          </td>
          <td class="text-end">${formatNumber.format(domain.messages)}</td>
          <td class="text-end">${alignment.toFixed(1)}%</td>
          <td class="next-step-cell" title="${escapeHtml(domain.next_step)}">${escapeHtml(domain.next_step)}</td>
        </tr>
      `;
    })
    .join("");

  body.querySelectorAll(".domain-row").forEach((row) => {
    row.addEventListener("click", () => openDomainModal(row.dataset.domain));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDomainModal(row.dataset.domain);
      }
    });
  });

  summary.textContent = state.domainSearch
    ? `${formatNumber.format(start + 1)}-${formatNumber.format(start + page.length)} of ${formatNumber.format(domains.length)} matches · ${formatNumber.format(state.domains.length)} domains total`
    : `${formatNumber.format(start + 1)}-${formatNumber.format(start + page.length)} of ${formatNumber.format(domains.length)} domains`;
  renderDomainPagination(pagination, totalPages);
}

function sortedDomains() {
  const { key, direction } = state.domainSort;
  const multiplier = direction === "asc" ? 1 : -1;
  return filteredDomains().sort((left, right) => {
    const result = compareDomainValue(domainSortValue(left, key), domainSortValue(right, key));
    if (result !== 0) return result * multiplier;
    return left.domain.localeCompare(right.domain, undefined, { sensitivity: "base" });
  });
}

function filteredDomains() {
  const query = state.domainSearch;
  if (!query) return [...state.domains];
  return state.domains.filter((domain) => {
    const alignment = domain.messages === 0 ? 0 : (domain.aligned / domain.messages) * 100;
    return [
      domain.domain,
      domain.policy,
      domain.grade,
      domain.next_step,
      String(domain.messages),
      `${alignment.toFixed(1)}%`,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function domainSortValue(domain, key) {
  if (key === "grade") return Number(domain.score || 0);
  if (key === "policy") return policySortValue(domain.policy);
  if (key === "messages") return Number(domain.messages || 0);
  if (key === "alignment") return domain.messages === 0 ? 0 : (domain.aligned / domain.messages) * 100;
  if (key === "next_step") return domain.next_step || "";
  return domain.domain || "";
}

function compareDomainValue(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

function policySortValue(policy) {
  if (policy === "reject") return 3;
  if (policy === "quarantine") return 2;
  if (policy === "none") return 1;
  return 0;
}

function defaultDomainSortDirection(key) {
  return ["grade", "messages", "alignment"].includes(key) ? "desc" : "asc";
}

function renderDomainSortState() {
  document.querySelectorAll("[data-sort-column]").forEach((header) => {
    const active = header.dataset.sortColumn === state.domainSort.key;
    const direction = active ? state.domainSort.direction : "none";
    header.setAttribute("aria-sort", direction === "none" ? "none" : direction === "asc" ? "ascending" : "descending");
    header.querySelector(".sort-indicator").textContent = active ? (direction === "asc" ? "↑" : "↓") : "";
    header.querySelector(".sort-button").classList.toggle("active", active);
  });
}

function renderDomainPagination(container, totalPages) {
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  const pages = paginationWindow(state.domainPage, totalPages);
  container.innerHTML = `
    <button class="btn btn-sm btn-outline-primary" type="button" data-page="${state.domainPage - 1}" ${state.domainPage === 1 ? "disabled" : ""} aria-label="Previous domains page">&lsaquo;</button>
    ${pages
      .map((page) => `
        <button class="btn btn-sm ${page === state.domainPage ? "btn-primary" : "btn-outline-primary"}" type="button" data-page="${page}" aria-label="Domains page ${page}">
          ${page}
        </button>
      `)
      .join("")}
    <button class="btn btn-sm btn-outline-primary" type="button" data-page="${state.domainPage + 1}" ${state.domainPage === totalPages ? "disabled" : ""} aria-label="Next domains page">&rsaquo;</button>
  `;

  container.querySelectorAll("button[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = Number(button.dataset.page);
      if (!Number.isFinite(page)) return;
      state.domainPage = Math.min(Math.max(1, page), totalPages);
      renderDomains();
    });
  });
}

function paginationWindow(current, total) {
  const start = Math.max(1, Math.min(current - 2, total - 4));
  const end = Math.min(total, start + 4);
  const pages = [];
  for (let page = start; page <= end; page += 1) pages.push(page);
  return pages;
}

function domainGradeTooltip(domain, alignment) {
  return [
    `Score ${domain.score}/100`,
    `Grade ${domain.grade}`,
    `${alignment.toFixed(1)}% alignment`,
    `${formatNumber.format(domain.messages)} messages`,
    `${formatNumber.format(domain.sources)} sources`,
    domain.next_step,
  ].join(" · ");
}

function domainPolicyTooltip(policy) {
  if (policy === "reject") return "p=reject · enforcing: non-compliant mail should be rejected";
  if (policy === "quarantine") return "p=quarantine · validation: non-compliant mail should be quarantined";
  if (policy === "none") return "p=none · monitoring only: no receiver-side enforcement";
  return `p=${policy || "unknown"} · policy could not be classified`;
}

function showAppTooltip(trigger) {
  const text = trigger.dataset.tooltip;
  if (!text) return;

  activeTooltipTrigger = trigger;
  const tooltip = ensureAppTooltip();
  tooltip.textContent = text;
  tooltip.hidden = false;
  positionAppTooltip(trigger, tooltip);
}

function hideAppTooltip() {
  activeTooltipTrigger = null;
  if (appTooltip) appTooltip.hidden = true;
}

function ensureAppTooltip() {
  if (appTooltip) return appTooltip;
  appTooltip = document.createElement("div");
  appTooltip.className = "app-tooltip";
  appTooltip.setAttribute("role", "tooltip");
  appTooltip.hidden = true;
  document.body.appendChild(appTooltip);
  return appTooltip;
}

function positionAppTooltip(trigger, tooltip) {
  const rect = trigger.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 10;
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - tooltipRect.width / 2),
    window.innerWidth - tooltipRect.width - margin,
  );
  const below = rect.bottom + margin;
  const above = rect.top - tooltipRect.height - margin;
  const top = below + tooltipRect.height < window.innerHeight ? below : Math.max(margin, above);

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function renderSources() {
  const list = document.getElementById("sources-list");
  if (!state.sources.length) {
    list.innerHTML = `<div class="empty">No source data yet.</div>`;
    return;
  }

  const groups = groupedSources();
  list.innerHTML = groups
    .slice(0, 12)
    .map(
      (source, index) => `
      <article class="source" tabindex="0" role="button" data-source-group-index="${index}" aria-label="Open source details for ${escapeHtml(source.sender)}">
        <div class="source-head">
          <div>
            <strong>${escapeHtml(source.sender)}</strong>
            <small>${formatNumber.format(source.source_count)} IPs · ${formatNumber.format(source.domain_count)} domains</small>
            ${domainChips(source.domains, 5)}
          </div>
          <span class="risk ${escapeHtml(source.risk)}">${escapeHtml(source.risk)}</span>
        </div>
        <div class="source-meta">
          <span>${formatNumber.format(source.messages)} messages</span>
          <span>${Number(source.alignment_rate || 0).toFixed(1)}% aligned</span>
          <span>${formatNumber.format(source.rejected)} rejected</span>
          <span>${formatNumber.format(source.quarantined)} quarantined</span>
        </div>
        <div class="bar"><i style="width: ${Math.max(3, Number(source.alignment_rate || 0))}%"></i></div>
      </article>
    `,
    )
    .join("");

  list.querySelectorAll("[data-source-group-index]").forEach((card) => {
    card.addEventListener("click", () => openSourceModal(Number(card.dataset.sourceGroupIndex)));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openSourceModal(Number(card.dataset.sourceGroupIndex));
      }
    });
  });
}

function groupedSources() {
  const groups = new Map();
  for (const source of state.sources) {
    const sender = source.sender || source.source_ip || "Unknown sender";
    const key = sender === "Unknown sender" || sender === source.source_ip
      ? `${sender}|${source.source_ip}`
      : sender;
    const group = groups.get(key) || {
      sender,
      domains: new Set(),
      messages: 0,
      aligned: 0,
      rejected: 0,
      quarantined: 0,
      source_count: 0,
      sources: [],
      risk: "low",
    };
    group.messages += Number(source.messages || 0);
    group.aligned += Number(source.aligned || 0);
    group.rejected += Number(source.rejected || 0);
    group.quarantined += Number(source.quarantined || 0);
    group.source_count += 1;
    group.sources.push(source);
    group.risk = highestRisk(group.risk, source.risk);
    for (const domain of source.domains || []) group.domains.add(domain);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      domains: [...group.domains].sort((left, right) => left.localeCompare(right)),
      domain_count: group.domains.size,
      alignment_rate: group.messages === 0 ? 0 : (group.aligned / group.messages) * 100,
      sources: group.sources.sort((left, right) => Number(right.messages || 0) - Number(left.messages || 0)),
    }))
    .sort((left, right) => right.messages - left.messages);
}

function domainChips(domains, limit = 6) {
  const list = domains || [];
  if (!list.length) return `<div class="source-domain-chips"><span>unknown domain</span></div>`;
  const visible = list.slice(0, limit);
  const extra = list.length - visible.length;
  return `
    <div class="source-domain-chips">
      ${visible.map((domain) => `<span>${escapeHtml(domain)}</span>`).join("")}
      ${extra > 0 ? `<span>+${formatNumber.format(extra)}</span>` : ""}
    </div>
  `;
}

function highestRisk(left, right) {
  const order = { low: 1, medium: 2, high: 3, critical: 4 };
  return (order[right] || 0) > (order[left] || 0) ? right : left;
}

function renderActions() {
  const list = document.getElementById("actions-list");
  if (!state.actions.length) {
    list.innerHTML = `<div class="empty">No remediation items yet.</div>`;
    return;
  }

  list.innerHTML = state.actions
    .slice(0, 8)
    .map(
      (item, index) => `
      <article class="action ${escapeHtml(item.severity)}" tabindex="0" role="button" data-action-index="${index}" aria-label="Open action details for ${escapeHtml(item.title)}">
        <span>${escapeHtml(item.severity)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.domain)}</small>
        <p>${escapeHtml(item.detail)}</p>
        <em>${escapeHtml(item.recommendation)}</em>
      </article>
    `,
    )
    .join("");

  list.querySelectorAll("[data-action-index]").forEach((card) => {
    card.addEventListener("click", () => openActionModal(Number(card.dataset.actionIndex)));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openActionModal(Number(card.dataset.actionIndex));
      }
    });
  });
}

function renderEvidence() {
  const stage = state.overview.enforcement_stage;
  document.getElementById("step-discover").classList.toggle("done", ["Discover", "Validate", "Enforce"].includes(stage));
  document.getElementById("step-validate").classList.toggle("done", ["Validate", "Enforce"].includes(stage));
  document.getElementById("step-enforce").classList.toggle("done", stage === "Enforce");

  const total = state.overview.policy_mix.reduce((sum, row) => sum + row.messages, 0) || 1;
  document.getElementById("policy-mix").innerHTML = state.overview.policy_mix.length
    ? state.overview.policy_mix
        .map((row) => {
          const width = Math.max(4, (row.messages / total) * 100);
          return `<div><span>${escapeHtml(row.policy)}</span><b style="width: ${width}%"></b><small>${formatNumber.format(row.messages)}</small></div>`;
        })
        .join("")
    : `<div><span>none</span><b style="width: 4%"></b><small>0</small></div>`;

  const select = document.getElementById("report-select");
  select.innerHTML = `<option value="">Select report</option>` + state.reports
    .map((report) => `<option value="${escapeHtml(report.id)}">${escapeHtml(report.domain)} · ${escapeHtml(report.org_name)}</option>`)
    .join("");
}

async function loadDetail(id) {
  const report = await fetchJson(`/api/reports/${encodeURIComponent(id)}`);
  const content = document.getElementById("detail-content");
  content.innerHTML = `
    <div class="record-grid">
      ${report.records
        .map(
          (record) => `
          <article class="record">
            <span>Source</span>
            <strong>${sourceIpWithFlag(record.source_ip)}</strong>
            <small>${formatNumber.format(record.count)} messages · ${escapeHtml(record.header_from || "unknown")}</small>
            <p>
              ${pill("DKIM", record.dkim_aligned)}
              ${pill("SPF", record.spf_aligned)}
              ${pill(record.disposition, record.disposition !== "reject")}
            </p>
          </article>
        `,
        )
        .join("")}
    </div>
  `;
}

async function openDomainModal(domain) {
  const modal = document.getElementById("domain-detail-modal");
  const title = document.getElementById("domain-modal-title");
  const body = document.getElementById("domain-modal-body");

  title.textContent = domain;
  body.innerHTML = `<div class="empty">Loading domain details...</div>`;
  modal.hidden = false;
  document.body.classList.add("modal-open");

  try {
    const detail = await fetchJson(`/api/domains/${encodeURIComponent(domain)}`);
    title.textContent = detail.summary.domain;
    body.innerHTML = renderDomainDetail(detail);
  } catch (error) {
    body.innerHTML = `<div class="empty">${escapeHtml(error.message || "Unable to load domain details.")}</div>`;
  }
}

function closeDomainModal() {
  const modal = document.getElementById("domain-detail-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function openProtocolModal(index) {
  const protocol = state.overview.protocols[index];
  if (!protocol) return;

  const modal = document.getElementById("protocol-detail-modal");
  const title = document.getElementById("protocol-modal-title");
  const body = document.getElementById("protocol-modal-body");

  title.textContent = protocol.name;
  body.innerHTML = renderProtocolDetail(protocol);
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeProtocolModal() {
  const modal = document.getElementById("protocol-detail-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function openSourceModal(index) {
  const group = groupedSources()[index];
  if (!group) return;

  const modal = document.getElementById("source-detail-modal");
  const title = document.getElementById("source-modal-title");
  const body = document.getElementById("source-modal-body");

  title.textContent = group.sender;
  body.innerHTML = renderSourceGroupDetail(group);
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeSourceModal() {
  const modal = document.getElementById("source-detail-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderSourceGroupDetail(group) {
  const alignment = group.messages === 0 ? 0 : (group.aligned / group.messages) * 100;
  return `
    <div class="action-detail-head ${escapeHtml(group.risk)}">
      <span>${escapeHtml(group.risk)}</span>
      <div>
        <h4>${escapeHtml(group.sender)}</h4>
        <p>${formatNumber.format(group.source_count)} source IPs · ${formatNumber.format(group.domain_count || 0)} domains</p>
      </div>
    </div>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Aggregate metrics</h4>
        <span>${escapeHtml((group.domains || []).join(", ") || "all domains")}</span>
      </div>
      <div class="domain-detail-grid">
        ${actionMetricCard("Messages", formatNumber.format(group.messages), domainMessagesStatus(group.messages))}
        ${actionMetricCard("Alignment", `${alignment.toFixed(1)}%`, domainAlignmentStatus(alignment))}
        ${actionMetricCard("Rejected", formatNumber.format(group.rejected), group.rejected > 0 ? "warn" : "good")}
        ${actionMetricCard("Quarantined", formatNumber.format(group.quarantined), group.quarantined > 0 ? "warn" : "good")}
      </div>
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Domains</h4>
        <span>${formatNumber.format(group.domain_count || 0)} domains</span>
      </div>
      ${domainChips(group.domains, 40)}
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Source IPs</h4>
        <span>${formatNumber.format(group.sources.length)} IPs</span>
      </div>
      ${renderSourceGroupTable(group.sources)}
    </section>
  `;
}

function renderSourceGroupTable(sources) {
  if (!sources.length) return `<div class="empty">No source IPs found for this group.</div>`;
  return `
    <div class="table-responsive">
      <table class="table table-sm align-middle domain-source-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Domains</th>
            <th>Geo</th>
            <th class="text-end">Messages</th>
            <th class="text-end">Alignment</th>
            <th class="text-end">Rejected</th>
          </tr>
        </thead>
        <tbody>
          ${sources
            .map((source) => {
              const point = geoPointForIp(source.source_ip);
              const enriched = {
                ...source,
                country: point?.country,
                country_code: point?.country_code,
                region: point?.city,
                continent: point?.continent,
                continent_code: point?.continent_code,
                asn_number: point?.asn_number,
                asn_organization: point?.asn_organization,
              };
              return `
                <tr>
                  <td>
                    <strong>${sourceIpWithFlag(source.source_ip)}</strong>
                    <small>${escapeHtml(source.sender || "Unknown sender")}</small>
                  </td>
                  <td>${escapeHtml((source.domains || []).join(", ") || "unknown")}</td>
                  <td>
                    ${escapeHtml(formatDomainSourceGeo(enriched))}
                    <small>${escapeHtml(formatGeoAsn(enriched))}</small>
                  </td>
                  <td class="text-end">${formatNumber.format(source.messages || 0)}</td>
                  <td class="text-end">
                    ${Number(source.alignment_rate || 0).toFixed(1)}%
                    <small>${formatNumber.format(source.aligned || 0)} aligned</small>
                  </td>
                  <td class="text-end">
                    ${formatNumber.format(source.rejected || 0)}
                    <small>${formatNumber.format(source.quarantined || 0)} quarantined</small>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function openActionModal(index) {
  const item = state.actions[index];
  if (!item) return;

  const modal = document.getElementById("action-detail-modal");
  const title = document.getElementById("action-modal-title");
  const body = document.getElementById("action-modal-body");

  title.textContent = item.title;
  body.innerHTML = `<div class="empty">Loading action details...</div>`;
  modal.hidden = false;
  document.body.classList.add("modal-open");

  let domainDetail = null;
  if (item.domain && item.domain !== "all domains" && item.domain !== "unknown") {
    try {
      domainDetail = await fetchJson(`/api/domains/${encodeURIComponent(item.domain)}`);
    } catch {
      domainDetail = null;
    }
  }

  body.innerHTML = renderActionDetail(item, domainDetail);
}

function closeActionModal() {
  const modal = document.getElementById("action-detail-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderActionDetail(item, domainDetail) {
  const domain = domainDetail?.summary || state.domains.find((row) => row.domain === item.domain);
  const sources = actionSources(item, domainDetail);
  const reports = domainDetail?.recent_reports || [];
  const alignment = domain?.messages ? (domain.aligned / domain.messages) * 100 : null;

  return `
    <div class="action-detail-head ${escapeHtml(item.severity)}">
      <span>${escapeHtml(item.severity)}</span>
      <div>
        <h4>${escapeHtml(item.title)}</h4>
        <p>${escapeHtml(item.detail)}</p>
      </div>
    </div>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Impact</h4>
        <span>${escapeHtml(item.domain || "all domains")}</span>
      </div>
      <div class="domain-detail-grid">
        ${actionMetricCard("Domain", domain?.domain || item.domain || "n/a", "neutral")}
        ${actionMetricCard("Messages", domain ? formatNumber.format(domain.messages) : "n/a", domainMessagesStatus(domain?.messages || 0))}
        ${actionMetricCard("Alignment", alignment === null ? "n/a" : `${alignment.toFixed(1)}%`, alignment === null ? "neutral" : domainAlignmentStatus(alignment))}
        ${actionMetricCard("Policy", domain ? `p=${domain.policy}` : "n/a", domain ? domainPolicyStatus(domain.policy) : "neutral")}
      </div>
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Evidence</h4>
        <span>${formatNumber.format(sources.length)} related sources</span>
      </div>
      ${renderActionSources(sources)}
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Reports</h4>
        <span>${reports.length ? `Latest ${formatNumber.format(reports.length)}` : "Current aggregate view"}</span>
      </div>
      ${reports.length ? renderDomainReports(reports) : renderActionFallbackEvidence(item)}
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Recommendation</h4>
      </div>
      <div class="protocol-recommendation">${escapeHtml(item.recommendation)}</div>
    </section>
  `;
}

function actionMetricCard(label, value, status) {
  return `
    <article class="domain-status-card ${status}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function actionSources(item, domainDetail) {
  const detailSources = domainDetail?.sources || [];
  const matching = detailSources.filter((source) => actionMatchesSource(item, source));
  const sources = matching.length ? matching : detailSources.slice(0, 6);
  if (sources.length) return sources.slice(0, 8);

  return state.sources
    .filter((source) => actionMatchesSource(item, source))
    .slice(0, 8)
    .map((source) => {
      const point = geoPointForIp(source.source_ip);
      return {
        ...source,
        provider: point?.provider,
        country: point?.country,
        country_code: point?.country_code,
        region: point?.city,
        continent: point?.continent,
        continent_code: point?.continent_code,
        asn_number: point?.asn_number,
        asn_organization: point?.asn_organization,
      };
    });
}

function actionMatchesSource(item, source) {
  const itemText = [
    item.detail,
    item.domain,
    item.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    (source.source_ip && itemText.includes(String(source.source_ip).toLowerCase())) ||
    (source.sender && source.sender !== "Unknown sender" && itemText.includes(String(source.sender).toLowerCase())) ||
    ((source.domains || []).some((domain) => String(item.domain || "").toLowerCase() === String(domain).toLowerCase()))
  );
}

function renderActionSources(sources) {
  if (!sources.length) {
    return `<div class="empty">No related source details were found for this action.</div>`;
  }

  return `
    <div class="table-responsive">
      <table class="table table-sm align-middle domain-source-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Geo</th>
            <th>ASN</th>
            <th class="text-end">Messages</th>
            <th class="text-end">Alignment</th>
            <th class="text-end">Rejected</th>
          </tr>
        </thead>
        <tbody>
          ${sources
            .map((source) => `
              <tr>
                <td>
                  <strong>${escapeHtml(source.sender || "Unknown sender")}</strong>
                  <small>${countryFlag(source.country_code)} ${escapeHtml(source.source_ip)}</small>
                </td>
                <td>${escapeHtml(formatDomainSourceGeo(source))}</td>
                <td>${escapeHtml(formatGeoAsn(source))}</td>
                <td class="text-end">${formatNumber.format(source.messages || 0)}</td>
                <td class="text-end">
                  ${Number(source.alignment_rate || 0).toFixed(1)}%
                  <small>${formatNumber.format(source.aligned || 0)} aligned</small>
                </td>
                <td class="text-end">
                  ${formatNumber.format(source.rejected || 0)}
                  <small>${formatNumber.format(source.quarantined || 0)} quarantined</small>
                </td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderActionFallbackEvidence(item) {
  return `
    <ul class="protocol-evidence">
      <li>${escapeHtml(item.detail)}</li>
      <li>Current global posture: ${escapeHtml(state.overview?.posture || "unknown")} · stage ${escapeHtml(state.overview?.enforcement_stage || "unknown")}</li>
    </ul>
  `;
}

function renderProtocolDetail(protocol) {
  const tooltip = protocolScoreTooltip(protocol);
  return `
    <div class="protocol-detail-head">
      <div class="protocol-detail-score ${protocolScoreStatus(protocol.score)}" tabindex="0" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}" style="--protocol-score: ${Number(protocol.score || 0)}">
        <strong>${Number(protocol.score || 0)}%</strong>
      </div>
      <div>
        <p class="mb-2">${escapeHtml(protocol.summary || protocol.detail)}</p>
        <small class="text-muted">${escapeHtml(protocol.detail)}</small>
      </div>
    </div>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Metrics</h4>
        <span>Current aggregate view</span>
      </div>
      <div class="protocol-metric-grid">
        ${(protocol.metrics || [])
          .map(
            (metric) => `
            <article class="protocol-metric-card ${protocolMetricStatus(metric)}">
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(metric.value)}</strong>
            </article>
          `,
          )
          .join("")}
      </div>
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Evidence</h4>
        <span>Why this status is shown</span>
      </div>
      <ul class="protocol-evidence">
        ${(protocol.evidence || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Recommendation</h4>
      </div>
      <div class="protocol-recommendation">${escapeHtml(protocol.recommendation || "Continue monitoring this protocol.")}</div>
    </section>
  `;
}

function protocolScoreTooltip(protocol) {
  return [
    `${Number(protocol.score || 0)}% coverage`,
    protocol.status,
    protocol.detail,
    protocol.recommendation,
  ]
    .filter(Boolean)
    .join(" · ");
}

function protocolMetricStatus(metric) {
  const label = String(metric.label || "").toLowerCase();
  const value = String(metric.value || "");
  const percent = Number(value.replace("%", ""));

  if (label.includes("rate") || label.includes("alignment")) {
    if (Number.isFinite(percent) && percent >= 98) return "good";
    if (Number.isFinite(percent) && percent >= 90) return "warn";
    return "bad";
  }

  if (label.includes("failures")) {
    const failures = Number(value.replace(/[^0-9.]/g, ""));
    if (failures === 0) return "good";
    if (failures < 100) return "warn";
    return "bad";
  }

  if (label.includes("rejected") || label.includes("quarantined")) {
    const count = Number(value.replace(/[^0-9.]/g, ""));
    return count > 0 ? "warn" : "neutral";
  }

  if (label.includes("aligned") || label.includes("reports") || label.includes("domains") || label.includes("messages") || label.includes("source")) {
    return "neutral";
  }

  return "neutral";
}

function protocolScoreStatus(score) {
  if (score >= 98) return "good";
  if (score >= 90) return "warn";
  return "bad";
}

function renderDomainDetail(detail) {
  const summary = detail.summary;
  const policy = detail.policy;
  const alignment = summary.messages === 0 ? 0 : (summary.aligned / summary.messages) * 100;

  return `
    <div class="domain-detail-grid">
      <article class="domain-status-card ${domainGradeStatus(summary.score)}">
        <span>Grade</span>
        <strong>${escapeHtml(summary.grade)}</strong>
        <small>${summary.score}/100 score</small>
      </article>
      <article class="domain-status-card ${domainMessagesStatus(summary.messages)}">
        <span>Messages</span>
        <strong>${formatNumber.format(summary.messages)}</strong>
        <small>${formatNumber.format(summary.aligned)} aligned</small>
      </article>
      <article class="domain-status-card ${domainAlignmentStatus(alignment)}">
        <span>Alignment</span>
        <strong>${alignment.toFixed(1)}%</strong>
        <small>${formatNumber.format(summary.sources)} sources</small>
      </article>
      <article class="domain-status-card ${domainPolicyStatus(policy.policy)}">
        <span>Policy</span>
        <strong>p=${escapeHtml(policy.policy)}</strong>
        <small>sp=${escapeHtml(policy.subdomain_policy || "inherit")} · pct=${policy.pct}</small>
      </article>
    </div>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Policy posture</h4>
      </div>
      <div class="policy-posture-callout ${domainPolicyStatus(policy.policy)}">
        <span>Recommended next step</span>
        <strong>${escapeHtml(summary.next_step)}</strong>
        <div class="domain-policy-row">
          ${alignmentModeCard("DKIM alignment", policy.adkim)}
          ${alignmentModeCard("SPF alignment", policy.aspf)}
          <span>Last report <strong>${summary.last_report ? escapeHtml(shortDate(summary.last_report)) : "n/a"}</strong></span>
        </div>
      </div>
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Sources</h4>
        <span>${formatNumber.format(detail.sources.length)} sender IPs</span>
      </div>
      ${renderDomainSourceTable(detail.sources)}
    </section>

    <section class="domain-detail-section">
      <div class="domain-section-title">
        <h4>Recent reports</h4>
        <span>Latest ${formatNumber.format(detail.recent_reports.length)}</span>
      </div>
      ${renderDomainReports(detail.recent_reports)}
    </section>
  `;
}

function alignmentModeCard(label, mode) {
  const normalized = String(mode || "r").toLowerCase() === "s" ? "s" : "r";
  const name = normalized === "s" ? "Strict" : "Relaxed";
  const detail = normalized === "s"
    ? "The authenticated domain must exactly match the visible From domain."
    : "Subdomains can align with the organizational From domain.";
  return `
    <span class="alignment-mode-card">
      ${escapeHtml(label)}
      <strong>${name} (${normalized})</strong>
      <small>${escapeHtml(detail)}</small>
    </span>
  `;
}

function domainGradeStatus(score) {
  if (score >= 90) return "good";
  if (score >= 70) return "warn";
  return "bad";
}

function domainMessagesStatus(messages) {
  if (messages <= 0) return "neutral";
  if (messages >= 1000) return "good";
  if (messages >= 25) return "warn";
  return "neutral";
}

function domainAlignmentStatus(alignment) {
  if (alignment >= 98) return "good";
  if (alignment >= 90) return "warn";
  return "bad";
}

function domainPolicyStatus(policy) {
  if (policy === "reject") return "good";
  if (policy === "quarantine") return "warn";
  if (policy === "none") return "bad";
  return "neutral";
}

function renderDomainSourceTable(sources) {
  if (!sources.length) return `<div class="empty">No source data for this domain.</div>`;

  return `
    <div class="table-responsive">
      <table class="table table-sm align-middle domain-source-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Geo</th>
            <th>ASN</th>
            <th class="text-end">Messages</th>
            <th class="text-end">Alignment</th>
            <th class="text-end">Rejected</th>
          </tr>
        </thead>
        <tbody>
          ${sources
            .map((source) => `
              <tr>
                <td>
                  <strong>${escapeHtml(source.sender || "Unknown sender")}</strong>
                  <small>${countryFlag(source.country_code)} ${escapeHtml(source.source_ip)}</small>
                </td>
                <td>${escapeHtml(formatDomainSourceGeo(source))}</td>
                <td>${escapeHtml(formatGeoAsn(source))}</td>
                <td class="text-end">${formatNumber.format(source.messages)}</td>
                <td class="text-end">
                  ${Number(source.alignment_rate || 0).toFixed(1)}%
                  <small>DKIM ${formatNumber.format(source.dkim_aligned)} · SPF ${formatNumber.format(source.spf_aligned)}</small>
                </td>
                <td class="text-end">
                  ${formatNumber.format(source.rejected)}
                  <small>${formatNumber.format(source.quarantined)} quarantined</small>
                </td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDomainReports(reports) {
  if (!reports.length) return `<div class="empty">No reports for this domain.</div>`;

  return `
    <div class="domain-report-list">
      ${reports
        .map((report) => {
          const alignment = report.messages === 0 ? 0 : (report.aligned / report.messages) * 100;
          return `
            <article>
              <div>
                <strong>${escapeHtml(report.org_name || "Unknown reporter")}</strong>
                <small>${escapeHtml(report.report_id)} · ${escapeHtml(shortDate(report.begin))} to ${escapeHtml(shortDate(report.end))}</small>
              </div>
              <div>
                <strong>${formatNumber.format(report.messages)}</strong>
                <small>${alignment.toFixed(1)}% aligned · ${formatNumber.format(report.sources)} sources</small>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function formatDomainSourceGeo(source) {
  if (!source.country && !source.country_code) return "Unresolved";
  return formatGeoLocation({
    city: source.region,
    country: source.country,
    country_code: source.country_code,
  });
}

async function syncMailbox(status) {
  status.textContent = "Syncing mailbox...";

  const response = await fetch("/api/mailbox/import", { method: "POST" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Mailbox sync failed" }));
    status.textContent = error.error;
    return;
  }

  const result = await response.json();
  status.textContent = `${result.messages_scanned}/${result.messages_matched} emails · ${result.attachments_found} attachments · ${result.imported} imported`;
  if (result.failed_attachments?.length) {
    status.textContent += ` · ${result.failed_attachments.length} failed`;
  }
  await load();
}

function mailboxFormPayload() {
  const passwordInput = document.getElementById("mailbox-password");
  return {
    host: document.getElementById("mailbox-host").value.trim(),
    port: Number(document.getElementById("mailbox-port").value || 993),
    username: document.getElementById("mailbox-username").value.trim(),
    password: passwordInput.value || (passwordInput.dataset.keepPassword === "true" ? "__KEEP__" : ""),
    mailbox: document.getElementById("mailbox-folder").value.trim() || "INBOX",
    unseen_only: document.getElementById("mailbox-unseen-only").checked,
    mark_seen: document.getElementById("mailbox-mark-seen").checked,
    max_messages: Number(document.getElementById("mailbox-max-messages").value || 500),
    since_hours: Number(document.getElementById("mailbox-since-hours").value || 24),
    scheduler_enabled: document.getElementById("mailbox-scheduler-enabled").checked,
    scheduler_interval_minutes: Number(document.getElementById("mailbox-scheduler-interval").value || 60),
  };
}

function fillMailboxForm(settings) {
  const maxMessagesInput = document.getElementById("mailbox-max-messages");
  document.getElementById("mailbox-host").value = settings.host || "";
  document.getElementById("mailbox-port").value = settings.port || 993;
  document.getElementById("mailbox-username").value = settings.username || "";
  document.getElementById("mailbox-folder").value = settings.mailbox || "INBOX";
  maxMessagesInput.min = "0";
  maxMessagesInput.value = settings.max_messages ?? 500;
  document.getElementById("mailbox-since-hours").value = String(settings.since_hours ?? 24);
  document.getElementById("mailbox-unseen-only").checked = settings.unseen_only ?? true;
  document.getElementById("mailbox-mark-seen").checked = settings.mark_seen ?? false;
  document.getElementById("mailbox-scheduler-enabled").checked = settings.scheduler_enabled ?? false;
  document.getElementById("mailbox-scheduler-interval").value = settings.scheduler_interval_minutes || 60;

  const passwordInput = document.getElementById("mailbox-password");
  passwordInput.value = "";
  passwordInput.dataset.keepPassword = settings.has_password ? "true" : "false";
  document.getElementById("mailbox-password-hint").textContent = settings.has_password
    ? "Password saved. Leave blank to keep it."
    : "Use an app password when MFA is enabled.";
}

function renderMailboxSchedulerStatus(status) {
  const target = document.getElementById("mailbox-scheduler-status");
  if (!target) return;
  if (!status?.enabled) {
    target.textContent = "Disabled";
    return;
  }
  if (status.running) {
    target.textContent = "Running now";
    return;
  }
  const parts = [];
  if (status.next_run_at) parts.push(`Next ${shortDateTime(status.next_run_at)}`);
  if (status.last_finished_at) {
    parts.push(`${status.last_success ? "Last OK" : "Last failed"} ${shortDateTime(status.last_finished_at)}`);
  }
  if (status.last_error) parts.push(status.last_error);
  target.textContent = parts.join(" · ") || `Every ${status.interval_minutes || 60} min`;
}

function renderProfile() {
  const user = state.user || {};
  const label = user.display_name || user.username || "Admin";
  const email = user.email || "admin@local";
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "AD";
  setText("profile-initials", initials);
  setText("profile-name", label);
  setText("profile-email", email);
  setText("profile-auth-type", user.auth_type === "oidc" ? "OIDC account" : "Local account");

  const isLocalAccount = user.auth_type !== "oidc";
  document.getElementById("change-password-link").hidden = !isLocalAccount;
}

function oidcFormPayload() {
  return {
    enabled: document.getElementById("oidc-enabled").checked,
    provider_name: document.getElementById("oidc-provider-name").value.trim(),
    issuer_url: document.getElementById("oidc-issuer-url").value.trim(),
    client_id: document.getElementById("oidc-client-id").value.trim(),
    client_secret: document.getElementById("oidc-client-secret").value,
    scopes: document.getElementById("oidc-scopes").value.trim(),
    auto_provision: document.getElementById("oidc-auto-provision").checked,
    show_local_login: document.getElementById("oidc-show-local-login").checked,
    force_sso_redirect: document.getElementById("oidc-force-sso").checked,
    app_base_url: document.getElementById("oidc-app-base-url").value.trim(),
  };
}

function fillOidcForm(settings) {
  document.getElementById("oidc-enabled").checked = settings.enabled;
  document.getElementById("oidc-provider-name").value = settings.provider_name || "SSO";
  document.getElementById("oidc-issuer-url").value = settings.issuer_url || "";
  document.getElementById("oidc-client-id").value = settings.client_id || "";
  document.getElementById("oidc-scopes").value = settings.scopes || "openid profile email";
  document.getElementById("oidc-auto-provision").checked = settings.auto_provision ?? true;
  document.getElementById("oidc-show-local-login").checked = settings.show_local_login ?? true;
  document.getElementById("oidc-force-sso").checked = settings.force_sso_redirect ?? false;
  document.getElementById("oidc-app-base-url").value = settings.app_base_url || "";
  document.getElementById("oidc-callback-url").value = settings.callback_url || "";

  const secret = document.getElementById("oidc-client-secret");
  secret.value = "";
  document.getElementById("oidc-client-secret-hint").textContent = settings.has_client_secret
    ? "Client secret saved. Leave blank to keep it."
    : "Required for confidential OIDC clients.";
}

function pill(label, ok) {
  return `<span class="pill ${ok ? "" : "bad"}">${escapeHtml(label)}</span>`;
}

function sourceIpWithFlag(sourceIp) {
  const point = geoPointForIp(sourceIp);
  const flag = countryFlag(point?.country_code);
  const title = point ? ` title="${escapeHtml(formatGeoLocation(point))}"` : "";
  return `<span class="ip-with-flag"${title}>${flag}<span>${escapeHtml(sourceIp)}</span></span>`;
}

function geoPointForIp(sourceIp) {
  return (state.geo.points || []).find((point) => point.source_ip === sourceIp);
}

function countryFlag(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return `<span class="flag-fallback" aria-hidden="true"></span>`;
  const symbols = [...code].map((char) => `&#${127397 + char.charCodeAt(0)};`).join("");
  return `<span class="country-flag" aria-label="${escapeHtml(code)}">${symbols}</span>`;
}

function slug(value) {
  return String(value).toLowerCase().replaceAll(" ", "-");
}

function protocolClass(status) {
  const key = slug(status);
  if (["active", "passing", "enabled"].includes(key)) return "bg-success";
  if (key === "missing") return "bg-danger";
  return "bg-warning";
}

function shortDate(value) {
  return formatDate.format(new Date(value));
}

function shortDateTime(value) {
  return formatDateTime.format(new Date(value));
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

load().catch((error) => {
  document.getElementById("upload-status").textContent = error.message;
});
