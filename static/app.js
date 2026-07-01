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
  geo: { points: [], unresolved_sources: 0 },
  user: null,
  oidcSettings: null,
  mailboxSchedulerStatus: null,
  trendRange: "30d",
  domainPage: 1,
  domainsPerPage: 12,
  domainSort: { key: "messages", direction: "desc" },
};

let geoMapInstance = null;
let geoLayerGroup = null;
let activeTooltipTrigger = null;
let appTooltip = null;
let manualSidebarActiveUntil = 0;
let searchTimer = null;
let searchAbortController = null;
let searchResults = [];

const sidebarLinks = [...document.querySelectorAll(".sidebar .nav-link[href^='#']")];
const themeToggle = document.getElementById("theme-toggle");
const globalSearchInput = document.getElementById("global-search-input");
const globalSearchResults = document.getElementById("global-search-results");

syncThemeToggle();

themeToggle?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-bs-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
});

document.getElementById("upload-form").addEventListener("submit", async (event) => {
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
    const target = document.querySelector(hash);
    if (!target) return;

    manualSidebarActiveUntil = Date.now() + 900;
    setActiveSidebarLink(hash);
    history.pushState(null, "", hash);
    target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible && Date.now() > manualSidebarActiveUntil) {
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

document.querySelectorAll("[data-trend-range]").forEach((button) => {
  button.addEventListener("click", () => {
    state.trendRange = button.dataset.trendRange;
    renderTrendRange();
    renderTrend();
  });
});

document.getElementById("domain-modal-close").addEventListener("click", closeDomainModal);
document.querySelector("[data-domain-modal-close]").addEventListener("click", closeDomainModal);
document.getElementById("protocol-modal-close").addEventListener("click", closeProtocolModal);
document.querySelector("[data-protocol-modal-close]").addEventListener("click", closeProtocolModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDomainModal();
    closeProtocolModal();
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
  const [session, overview, domains, sources, actions, timeline, reports, geo, mailboxSettings, mailboxSchedulerStatus, oidcSettings] = await Promise.all([
    fetchJson("/api/auth/session"),
    fetchJson("/api/overview"),
    fetchJson("/api/domains"),
    fetchJson("/api/top-sources"),
    fetchJson("/api/action-items"),
    fetchJson("/api/timeline"),
    fetchJson("/api/reports"),
    fetchJson("/api/geo-sources"),
    fetchJson("/api/settings/mailbox"),
    fetchJson("/api/mailbox/scheduler/status"),
    fetchJson("/api/settings/oidc"),
  ]);

  state.user = session.user;
  state.overview = overview;
  state.domains = domains;
  state.sources = sources;
  state.actions = actions;
  state.timeline = timeline;
  state.reports = reports;
  state.geo = geo;
  state.mailboxSchedulerStatus = mailboxSchedulerStatus;
  state.oidcSettings = oidcSettings;
  state.domainPage = Math.min(state.domainPage, Math.max(1, Math.ceil(state.domains.length / state.domainsPerPage)));

  renderProfile();
  renderOverview();
  renderTrendRange();
  renderTrend();
  renderProtocols();
  renderGeoMap();
  renderDomains();
  renderSources();
  renderActions();
  renderEvidence();
  fillMailboxForm(mailboxSettings);
  renderMailboxSchedulerStatus(mailboxSchedulerStatus);
  fillOidcForm(oidcSettings);
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
  const target = document.querySelector(hash);
  if (!target) return;
  setActiveSidebarLink(hash);
  history.pushState(null, "", hash);
  target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
}

async function refreshMailboxSchedulerStatus() {
  const schedulerStatus = await fetchJson("/api/mailbox/scheduler/status");
  state.mailboxSchedulerStatus = schedulerStatus;
  renderMailboxSchedulerStatus(schedulerStatus);
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

function renderOverview() {
  const stats = state.overview.statistics;
  setText("grade", state.overview.grade);
  setText("score", `${state.overview.score}/100`);
  setText("score-detail", scoreDetailText(state.overview.score, stats.compliance_rate));
  setText("metric-domains", formatNumber.format(stats.domains));
  setText("metric-reports", `${formatNumber.format(stats.reports)} reports`);
  setText("metric-messages", formatNumber.format(stats.messages));
  setText("metric-aligned", `${formatNumber.format(stats.aligned)} aligned`);
  setText("metric-alignment", `${stats.compliance_rate.toFixed(1)}%`);
  setText("metric-actions", `${state.actions.length} actions`);
  const scoreRing = document.getElementById("score-ring");
  scoreRing.style.setProperty("--score", state.overview.score);
  scoreRing.style.setProperty("--score-color", scoreColor(state.overview.score));
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
          .map(
            (point, index) => `
            <circle class="trend-point" cx="${point.x}" cy="${point.y}" r="3.5">
              <title>${escapeHtml(shortDate(points[index].date))} · ${formatNumber.format(points[index].messages)} messages · ${formatNumber.format(points[index].aligned)} aligned</title>
            </circle>
          `,
          )
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

function renderTrendRange() {
  document.querySelectorAll("[data-trend-range]").forEach((button) => {
    const active = button.dataset.trendRange === state.trendRange;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function filteredTrendPoints() {
  const days = Number(state.trendRange.replace("d", "")) || 1;
  const points = state.timeline
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
  const points = state.geo.points || [];
  const max = Math.max(...points.map((point) => point.messages), 1);
  const visible = points
    .filter((point) => Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)))
    .slice(0, 250);

  const provider = state.geo.provider || "local fallback";
  document.getElementById("geo-summary").textContent =
    `${points.length} located sources · ${state.geo.unresolved_sources || 0} unresolved · ${provider}`;

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
          <td><strong>${escapeHtml(domain.domain)}</strong><small>${domain.sources} sources</small></td>
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
          <td>${escapeHtml(domain.next_step)}</td>
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

  summary.textContent = `${formatNumber.format(start + 1)}-${formatNumber.format(start + page.length)} of ${formatNumber.format(domains.length)} domains`;
  renderDomainPagination(pagination, totalPages);
}

function sortedDomains() {
  const { key, direction } = state.domainSort;
  const multiplier = direction === "asc" ? 1 : -1;
  return [...state.domains].sort((left, right) => {
    const result = compareDomainValue(domainSortValue(left, key), domainSortValue(right, key));
    if (result !== 0) return result * multiplier;
    return left.domain.localeCompare(right.domain, undefined, { sensitivity: "base" });
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

  list.innerHTML = state.sources
    .slice(0, 12)
    .map(
      (source) => `
      <article class="source">
        <div class="source-head">
          <div>
            <strong>${escapeHtml(source.sender || source.source_ip)}</strong>
            <small>${sourceIpWithFlag(source.source_ip)} · ${escapeHtml((source.domains || []).join(", ") || "unknown domain")}</small>
          </div>
          <span class="risk ${escapeHtml(source.risk)}">${escapeHtml(source.risk)}</span>
        </div>
        <div class="source-meta">
          <span>${formatNumber.format(source.messages)} messages</span>
          <span>${Number(source.alignment_rate || 0).toFixed(1)}% aligned</span>
          <span>${formatNumber.format(source.rejected)} rejected</span>
        </div>
        <div class="bar"><i style="width: ${Math.max(3, Number(source.alignment_rate || 0))}%"></i></div>
      </article>
    `,
    )
    .join("");
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
      (item) => `
      <article class="action ${escapeHtml(item.severity)}">
        <span>${escapeHtml(item.severity)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.domain)}</small>
        <p>${escapeHtml(item.detail)}</p>
        <em>${escapeHtml(item.recommendation)}</em>
      </article>
    `,
    )
    .join("");
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
        <span>${escapeHtml(summary.next_step)}</span>
      </div>
      <div class="domain-policy-row">
        <span>DKIM alignment <strong>${escapeHtml(policy.adkim || "r")}</strong></span>
        <span>SPF alignment <strong>${escapeHtml(policy.aspf || "r")}</strong></span>
        <span>Last report <strong>${summary.last_report ? escapeHtml(shortDate(summary.last_report)) : "n/a"}</strong></span>
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
  document.getElementById("mailbox-host").value = settings.host || "";
  document.getElementById("mailbox-port").value = settings.port || 993;
  document.getElementById("mailbox-username").value = settings.username || "";
  document.getElementById("mailbox-folder").value = settings.mailbox || "INBOX";
  document.getElementById("mailbox-max-messages").value = settings.max_messages || 500;
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
