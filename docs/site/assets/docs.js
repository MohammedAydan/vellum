(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem("vellum-docs-theme");
  if (saved) root.dataset.theme = saved;
  document.getElementById("themeToggle").addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next; localStorage.setItem("vellum-docs-theme", next);
  });
  document.querySelectorAll(".cb-copy").forEach((btn) => btn.addEventListener("click", async () => {
    const block = btn.closest(".code-block");
    const heads = [...block.querySelectorAll(".cb-head")];
    const pres = [...block.querySelectorAll("pre")];
    const target = pres[heads.indexOf(btn.closest(".cb-head"))] || pres[0];
    try { await navigator.clipboard.writeText(target.textContent || ""); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1400); } catch { btn.textContent = "Failed"; }
  }));
  document.querySelectorAll(".et-tab").forEach((tab) => tab.addEventListener("click", () => {
    const wrap = tab.closest("[data-example-tabs]");
    const key = tab.dataset.exampleTab;
    wrap.querySelectorAll(".et-tab").forEach((b) => { const on = b === tab; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
    wrap.querySelectorAll(".et-panel").forEach((p) => { p.hidden = p.dataset.examplePanel !== key; });
  }));
  const base = document.body.dataset.base || "";
  let index = [];
  fetch(base + "assets/search-index.json").then((r) => r.json()).then((d) => (index = d)).catch(() => {});
  const overlay = document.getElementById("searchOverlay");
  const input = document.getElementById("searchInput");
  const results = document.getElementById("searchResults");
  const open = () => { overlay.hidden = false; input.focus(); };
  const close = () => { overlay.hidden = true; input.value = ""; results.innerHTML = ""; };
  document.getElementById("searchTrigger").addEventListener("click", open);
  document.getElementById("searchClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
    if (e.key === "Escape") close();
  });
  const runSearch = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ""; return; }
    const hits = index.filter((p) => (p.title + " " + p.description + " " + p.text).toLowerCase().includes(q)).slice(0, 12);
    results.innerHTML = hits.length ? hits.map((p) => `<a class="search-item" href="${base + p.url}"><em>${p.group}</em><strong>${p.title}</strong><span>${p.description}</span></a>`).join("") : `<div class="search-item"><span>—</span></div>`;
  };
  input.addEventListener("input", runSearch);
  const current = decodeURIComponent(location.pathname.split("/").pop().replace(".html", ""));
  document.querySelectorAll(".nav-link").forEach((a) => {
    const href = decodeURIComponent(a.getAttribute("href") || "").replace(".html", "");
    if (href === current || (href.endsWith("/" + current) && current.includes("/"))) a.classList.add("active");
  });
  const links = [...document.querySelectorAll(".toc-link")];
  if ("IntersectionObserver" in window && links.length) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((l) => l.classList.toggle("active", l.getAttribute("href") === "#" + entry.target.id));
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    document.querySelectorAll("h2[id],h3[id]").forEach((h) => obs.observe(h));
  }
  document.getElementById("mobileMenu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
})();