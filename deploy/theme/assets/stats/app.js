/*
 * 统计页的外壳和路由：
 *   启动 → 读 Grafana 数据源、TeslaMate 设置和车辆 → 按主题设置配色 → 画外壳（顶栏 / 手机底栏 / 页头）
 *   → 按路由加载 pages/ 下的模块，调它的 render(ctx)。
 * 页面模块的约定见 pages/registry.js 和 CORE_API.md。
 */
import * as api from "./core/api.js";
import * as fmt from "./core/format.js";
import * as ui from "./core/ui.js";
import { html, icon, render } from "./core/ui.js";
import * as range from "./core/range.js";
import { match, byPath, dashboardTitle } from "./pages/registry.js";

const doc = document;
const root = doc.documentElement;
const THEME_KEY = "tm-stats-theme";
const CAR_KEY = "tm-stats-car";

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等拿不到 localStorage：只是记不住，不影响使用 */
  }
  return null;
}

// ---------------------------------------------------------------- 主题

// ?theme=dark|light：调试用，只影响当前这次打开，不写 localStorage
const debugTheme = (() => {
  const t = new URLSearchParams(location.search).get("theme");
  return t === "dark" || t === "light" ? t : null;
})();
let themeMode = store(THEME_KEY) || "system";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const t = debugTheme || (themeMode === "system" ? (darkQuery.matches ? "dark" : "light") : themeMode);
  const changed = root.dataset.theme !== t;
  root.dataset.theme = t;
  const chrome = getComputedStyle(root).getPropertyValue("--tm-chrome").trim();
  for (const m of doc.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", chrome);
  if (changed) window.dispatchEvent(new Event("tm-themechange"));
}

darkQuery.addEventListener("change", applyTheme);

// ---------------------------------------------------------------- 进度条（同 theme.js）

const progress = (() => {
  let bar = null;
  let showTimer = 0;
  let hideTimer = 0;
  return {
    mount(el) {
      bar = el;
    },
    start() {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        bar.style.transition = "none";
        bar.className = "";
        void bar.offsetWidth;
        bar.style.transition = "";
        bar.className = "is-active";
      }, 120);
    },
    done() {
      clearTimeout(showTimer);
      if (bar.className !== "is-active") return;
      bar.className = "is-done";
      hideTimer = setTimeout(() => (bar.className = ""), 600);
    }
  };
})();

// ---------------------------------------------------------------- 外壳

const NAV = [
  { href: "/", label: "主页", icon: "car-side", cls: "tm-nav-home" },
  { href: "/stats/", label: "统计", icon: "chart-box-outline", current: true },
  { href: "/geo-fences", label: "收藏点", icon: "map-marker-radius" },
  { href: "/settings", label: "设置", icon: "cog" }
];

let headEl;
let viewEl;

function renderShell() {
  render(
    doc.body,
    html`<div id="tm-progress" aria-hidden="true"></div>
      <header class="tm-top">
        <div class="tm-top-inner">
          <a class="tm-brand" href="/" aria-label="TeslaMate 主页"><img src="/images/logo.svg" alt="TeslaMate" width="104" height="13"></a>
          <nav class="tm-nav" aria-label="主导航">
            <div class="tm-nav-items">
              ${NAV.map(
                (n) =>
                  html`<a href="${n.href}"${n.cls ? html` class="${n.cls}"` : ""}${n.current ? html` aria-current="page"` : ""}>${icon(n.icon)}<span>${n.label}</span></a>`
              )}
            </div>
          </nav>
        </div>
      </header>
      <main class="tm-main" id="main">
        <div class="tm-head" id="tm-head"></div>
        <div id="tm-view"></div>
      </main>`
  );
  progress.mount(doc.getElementById("tm-progress"));
  headEl = doc.getElementById("tm-head");
  viewEl = doc.getElementById("tm-view");
  headEl.addEventListener("click", onHeadClick);
}

// ---------------------------------------------------------------- 车辆

function pickCar(param) {
  const cars = api.cars;
  if (!cars.length) return null;
  const byId = (id) => (id == null ? null : cars.find((c) => String(c.id) === String(id)));
  return byId(param) || byId(store(CAR_KEY)) || cars[0];
}

// ---------------------------------------------------------------- 路由

let seq = 0;
let page = null; // 当前页面：{ controller, cleanups, ctx, route, mod, range }
const moduleCache = new Map();

function importPage(file, bust) {
  if (!bust && moduleCache.has(file)) return moduleCache.get(file);
  const p = import(`./pages/${file}${bust ? "?v=" + Date.now() : ""}`);
  moduleCache.set(file, p);
  p.catch(() => moduleCache.delete(file));
  return p;
}

const cssLoaded = new Map();
function loadPageCss(file) {
  const href = `/stats/pages/${file.replace(/\.js$/, ".css")}`;
  if (!cssLoaded.has(href)) {
    cssLoaded.set(
      href,
      new Promise((resolve) => {
        const l = doc.createElement("link");
        l.rel = "stylesheet";
        l.href = href;
        l.onload = resolve;
        // 样式没加载出来也照样显示页面
        l.onerror = resolve;
        doc.head.appendChild(l);
      })
    );
  }
  return cssLoaded.get(href);
}

function leave() {
  ui.closeSheet();
  if (!page) return;
  page.controller.abort();
  for (const fn of page.cleanups.splice(0)) {
    try {
      fn();
    } catch (e) {
      console.warn("[stats] 清理出错", e);
    }
  }
  page = null;
}

// 站内链接：保留 car（多车时）和 theme（调试）参数
function href(path, query) {
  const u = new URL(path, location.origin);
  const cur = new URLSearchParams(location.search);
  for (const k of ["car", "theme"]) if (cur.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, cur.get(k));
  if (query) for (const [k, v] of Object.entries(query)) v == null ? u.searchParams.delete(k) : u.searchParams.set(k, String(v));
  return u.pathname + u.search + u.hash;
}

function saveScroll() {
  const st = history.state || {};
  if (st.scroll !== window.scrollY) history.replaceState({ ...st, scroll: window.scrollY }, "");
}

let scrollTimer = 0;
window.addEventListener(
  "scroll",
  () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveScroll, 120);
  },
  { passive: true }
);

function navigate(to, { replace = false } = {}) {
  const u = new URL(to, location.href);
  // 点的是当前这一页（比如在统计首页再点顶栏的「统计」）：原地重画，不再压一条一样的历史，免得后退像没反应
  if (u.href === location.href) replace = true;
  clearTimeout(scrollTimer);
  saveScroll();
  const st = history.state || {};
  if (replace) history.replaceState({ idx: st.idx || 0, prevTitle: st.prevTitle }, "", u);
  else history.pushState({ idx: (st.idx || 0) + 1, prevTitle: page ? page.title : "统计" }, "", u);
  show({ scroll: 0 });
}

function goBack(parent) {
  const st = history.state || {};
  if ((st.idx || 0) > 0) history.back();
  else navigate(href(parent), { replace: true });
}

function setQuery(obj, { push = false } = {}) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(obj)) v == null || v === "" ? u.searchParams.delete(k) : u.searchParams.set(k, String(v));
  if (u.href === location.href) return;
  clearTimeout(scrollTimer);
  saveScroll();
  const st = history.state || {};
  if (push) history.pushState({ idx: (st.idx || 0) + 1, prevTitle: page ? page.title : st.prevTitle }, "", u);
  else history.replaceState(st, "", u);
  show({ scroll: null });
}

window.addEventListener("popstate", () => {
  // 上一页还没来得及记下的滚动位置不能再写了：history.state 已经换成要回去的那一条
  clearTimeout(scrollTimer);
  const st = history.state || {};
  show({ scroll: st.scroll || 0, restore: true });
});

// 真正的静态文件（和 nginx 配置 teslamate-theme.conf 里的扩展名列表保持一致）。
// /stats/drives/1.5 这种不算：交给路由，显示「找不到这条记录」
const STATIC_FILE = /\.(js|css|png|svg|json|map|woff2?|ico|txt|webp)$/;

doc.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || !(u.pathname === "/stats" || u.pathname.startsWith("/stats/"))) return;
  if (STATIC_FILE.test(u.pathname)) return;
  // 同一页里的锚点交给浏览器
  if (u.hash && u.pathname === location.pathname && u.search === location.search) return;
  e.preventDefault();
  if (a.hasAttribute("data-back")) goBack(a.getAttribute("href"));
  else navigate(u.pathname + u.search + u.hash);
});

// 鼠标移到站内链接上就预取页面模块（很小），点下去时基本不用等
const prefetched = new Set();
doc.addEventListener(
  "pointerover",
  (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/stats"]');
    if (!a) return;
    const m = match(new URL(a.href).pathname);
    if (m && !prefetched.has(m.route.module)) {
      prefetched.add(m.route.module);
      importPage(m.route.module).catch(() => prefetched.delete(m.route.module));
    }
  },
  { passive: true }
);

// ---------------------------------------------------------------- 页头

function pageTitle(t) {
  doc.title = t && t !== "统计" ? `${t} · 统计 · TeslaMate` : "统计 · TeslaMate";
}

// r：范围条；rangePending：默认范围还在算（range.auto），先放一个占位的范围条
function renderHead({ title, route, r, car, loading, rangePending }) {
  const st = history.state || {};
  const isHome = route && route.path === "/stats/";
  const parent = (route && route.parent) || "/stats/";
  const parentTitle = (byPath(parent) || { title: "统计" }).title;
  const backLabel = (st.idx || 0) > 0 && st.prevTitle ? st.prevTitle : parentTitle;
  const multi = api.cars.length > 1 && car;
  render(
    headEl,
    html`${!isHome
        ? html`<a class="tm-back" href="${href(parent)}" data-back>${icon("chevron-left")}<span>${backLabel}</span></a>`
        : ""}
      <div class="tm-head-row">
        <h1 class="tm-title" id="tm-title">${title}</h1>
        ${route && !loading
          ? html`<button type="button" class="tm-icon-btn" data-tm-more aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${icon("dots-horizontal")}</button>`
          : ""}
      </div>
      ${multi
        ? html`<button type="button" class="tm-car-btn" data-cars aria-haspopup="menu" aria-expanded="false" aria-label="切换车辆，当前：${car.label}">${icon("car-side")}<span>${car.label}</span>${icon("chevron-down")}</button>`
        : ""}
      ${r ? range.bar(r) : rangePending ? range.barPending() : ""}`
  );
}

function grafanaLink(uid, extra = {}) {
  const p = page;
  const params = {};
  if (p && p.range) {
    params.from = p.range.from;
    params.to = p.range.to;
  }
  if (p && p.car) params["var-car_id"] = p.car.id;
  if (p && p.route.grafanaVars) Object.assign(params, p.route.grafanaVars(p.params));
  if (p && p.grafanaExtra) Object.assign(params, p.grafanaExtra);
  // setGrafanaVars(obj, uid) 只给这个面板的（电量和里程页对应两个面板，各有各的变量）
  if (p && p.grafanaByUid && p.grafanaByUid.has(uid)) Object.assign(params, p.grafanaByUid.get(uid));
  return api.grafanaUrl(uid, { ...params, ...extra });
}

function onHeadClick(e) {
  if (!page) return;
  const p = page;
  const step = e.target.closest("[data-range-step]");
  if (step && p.range) {
    const next = p.range.step(+step.dataset.rangeStep);
    if (next) pickRange(next.key);
    return;
  }
  const open = e.target.closest("[data-range-open]");
  if (open && p.range) {
    range.openPicker(open, p.range, pickRange, { defaultKey: p.rangeDefault });
    return;
  }
  // 属性带 tm- 前缀：页面自己的「更多」按钮常叫 data-more，免得选择器一起选中
  const more = e.target.closest("[data-tm-more]");
  if (more) openMore(more);
  const carBtn = e.target.closest("[data-cars]");
  if (carBtn) ui.openSheet(carBtn, ui.menu(carItems(p)), { title: "切换车辆" });
}

function carItems(p) {
  return api.cars.map((c) => ({
    label: c.label,
    icon: "car-side",
    checked: p.car && c.id === p.car.id,
    onClick: () => {
      store(CAR_KEY, String(c.id));
      // 详情页的 id 是上一辆车的行程 / 充电，换车后没有意义，回到上级列表
      if (Object.keys(p.params || {}).length) navigate(href(p.route.parent || "/stats/", { car: c.id }));
      else setQuery({ car: c.id });
    }
  }));
}

// 选中的正好是默认范围时不写 r。有 range.auto 的页面，URL 里已经有 r 时默认值是在后台算的（rangeAuto），
// 要等它算完再比：否则拿固定的 default 比，点「近7天」可能被当成默认值删掉 r，又变回自动范围
async function pickRange(key) {
  const p = page;
  if (!p) return;
  const auto = p.rangeAuto ? await p.rangeAuto : null;
  if (page !== p) return;
  setQuery({ r: key === (auto || p.rangeDefault) ? null : key });
}

// 调页面的 range.auto(ctx) 算默认范围。不会 reject：出错、页面已离开、算出来的 key 不合法都给 null（用固定的 default）
function runAuto(mod, actx, token) {
  // 同步调用：auto 里第一条查询在外壳改 api 上下文（换成页面范围）之前就发出去，和没有 r 时一样
  let p;
  try {
    p = Promise.resolve(mod.range.auto(actx));
  } catch (e) {
    p = Promise.reject(e);
  }
  return p.then(
    (key) => (typeof key === "string" && range.parse(key) ? key : null),
    (e) => {
      // 登录过期、断网这类问题 render 里的查询会再碰到，由那边显示
      if (token === seq && e && e.name !== "AbortError" && !e.auth && !e.network) console.warn("[stats] range.auto 出错，用默认范围", e);
      return null;
    }
  );
}

function openMore(btn) {
  const p = page;
  const items = [];
  const uids = p.route.grafana ? [].concat(p.route.grafana) : [];
  for (const uid of uids) {
    items.push({
      label: uids.length > 1 ? `在 Grafana 中打开「${dashboardTitle(uid)}」` : "在 Grafana 中打开",
      icon: "open-in-new",
      href: grafanaLink(uid),
      external: true
    });
  }
  items.push({
    label: "刷新数据",
    icon: "refresh",
    onClick: () => {
      api.clearCache();
      show({ scroll: null });
    }
  });
  if (api.cars.length > 1) items.push({ sep: true }, { heading: "车辆" }, ...carItems(p));
  ui.openSheet(btn, ui.menu(items), { title: "更多" });
}

// ---------------------------------------------------------------- 渲染一页

// scroll：0 回到顶部；数字 + restore：画完后滚到这个位置（后退、刷新）；null：留在原处（setQuery、刷新数据）
async function show({ scroll = 0, restore = false, bust = false } = {}) {
  const token = ++seq;
  leave();
  const url = new URL(location.href);
  const m = match(url.pathname);
  progress.start();
  if (scroll === 0 && !restore) window.scrollTo(0, 0);

  const view = doc.createElement("div");
  view.className = "tm-page";
  // 留在原处时先把新页面撑到旧页面的高度：否则等数据的那一下页面只剩骨架，
  // 浏览器会把滚动位置夹到顶上，画完也回不去（页面中间的分段选择一点就跳回顶部）
  const prev = viewEl.firstElementChild;
  if (scroll === null && prev) view.style.minHeight = prev.offsetHeight + "px";
  viewEl.replaceChildren(view);

  if (!m) {
    pageTitle("找不到页面");
    renderHead({ title: "找不到页面", route: null });
    render(view, ui.empty("这个地址没有对应的统计页。", { icon: "help-circle-outline", action: ui.button("回到统计", { href: href("/stats/"), kind: "soft" }) }));
    view.style.minHeight = "";
    progress.done();
    return;
  }

  const { route, params } = m;
  const car = pickCar(url.searchParams.get("car"));
  const controller = new AbortController();
  const cleanups = [];
  page = { controller, cleanups, route, params, car, range: null, rangeDefault: null, rangeAuto: null, title: route.title, grafanaExtra: null, grafanaByUid: new Map() };
  const current = page;
  ui._setScope(cleanups);
  pageTitle(route.title);
  renderHead({ title: route.title, route, loading: true });

  if (!car && !route.noCar) {
    renderHead({ title: route.title, route });
    render(view, ui.card(ui.empty("TeslaMate 记录到车辆数据后，这里就会显示统计。", { icon: "car-side", title: "还没有车辆数据" })));
    view.style.minHeight = "";
    progress.done();
    return;
  }

  let mod;
  try {
    mod = await importPage(route.module, bust);
    if (mod.css) await loadPageCss(route.module);
  } catch (e) {
    if (token !== seq) return;
    console.error(e);
    renderHead({ title: route.title, route: null });
    render(view, ui.error(new Error("页面加载失败：" + (e.message || e)), () => show({ scroll: null, bust: true })));
    view.style.minHeight = "";
    progress.done();
    return;
  }
  if (token !== seq) return;

  const title = mod.title || route.title;
  current.title = title;
  pageTitle(title);
  const vars = api.commonVars(car);
  const carSince = car ? car.since : null;

  // 时间范围：URL 的 r（不合法当没有）；没有就用页面的默认值。
  // default 可以是函数（按查询参数算）。有 auto 时：没有 r 就先查库算出默认值再画页头（不先闪一下别的范围）；
  // 有 r 就照 r 画，auto 在后台算，只给 pickRange 和选择面板里的「默认」那一项用
  let r = null;
  let asked = null;
  if (mod.range) {
    let def = range.defaultKey(mod.range, url.searchParams);
    asked = range.parse(url.searchParams.get("r") || "");
    if (typeof mod.range.auto === "function") {
      api.setContext({ vars, range: null });
      const auto = runAuto(
        mod,
        {
          car,
          cars: api.cars,
          carSince,
          settings: api.settings,
          vars: { ...vars },
          params: { ...params },
          query: new URLSearchParams(url.search),
          signal: controller.signal
        },
        token
      );
      current.rangeAuto = auto;
      if (asked) {
        auto.then((key) => {
          if (key && page === current) current.rangeDefault = key;
        });
      } else {
        renderHead({ title, route, car, rangePending: true });
        render(view, ui.skeleton(["stats", "list"]));
        const key = await auto;
        if (token !== seq) return;
        if (key) def = key;
      }
    }
    // pickRange 拿它比较：选中的正好是默认值时不写 r
    current.rangeDefault = def;
    r = asked || range.resolve(def);
    current.range = r;
  }
  renderHead({ title, route, r, car });

  api.setContext({ vars, range: r ? { from: r.from, to: r.to } : null });

  const ctx = {
    root: view,
    params: { ...params },
    query: new URLSearchParams(url.search),
    range: r
      ? {
          key: r.key,
          kind: r.kind,
          from: r.from,
          to: r.to,
          label: r.label,
          span: r.span,
          // 画时间轴用：范围早于这辆车最早的记录时从那条记录算起（见 range.effectiveFrom）
          effFrom: range.effectiveFrom(r, carSince),
          // URL 里没有 r，用的是页面的默认范围（「看默认范围」这类按钮据此决定显不显示，链接写 { r: null }）
          isDefault: !asked,
          // 页面的默认范围 key（按查询参数算的、或 auto 查库算的）。有 auto 且 URL 里有 r 时还不知道，是 null
          defaultKey: asked && current.rangeAuto ? null : current.rangeDefault
        }
      : null,
    car,
    cars: api.cars,
    // 这辆车最早一条记录（行程 / 充电 / 位置点）的时间，毫秒；没有记录时 null
    carSince,
    settings: api.settings,
    vars: { ...vars },
    signal: controller.signal,
    // 页面在 await 期间已经离开时，清理函数登记进去也不会再有人调用（定时器就漏了），所以立刻执行
    onCleanup: (fn) => (controller.signal.aborted ? fn() : cleanups.push(fn)),
    setTitle(text) {
      if (page !== current) return;
      current.title = text;
      const h = doc.getElementById("tm-title");
      if (h) h.textContent = text;
      pageTitle(text);
    },
    // URL 真的变了才会重画；参数和现在一样时什么都不做（要强制重画用 rerender）
    setQuery(obj, opts) {
      if (page === current) setQuery(obj, opts);
    },
    // 原地重画本页（新 root，滚动位置保留，查询走 60 秒缓存）
    rerender() {
      if (page === current) show({ scroll: null });
    },
    // 给页头「在 Grafana 中打开」的链接加参数（覆盖上一次设的；null 清掉）。值是数组时写成多个同名参数。
    // 给了 uid 时只作用于那个面板的链接（一页对应多个面板时用），和不带 uid 设的参数叠加，同名的以它为准
    setGrafanaVars(obj, uid) {
      const v = obj ? { ...obj } : null;
      if (uid == null) current.grafanaExtra = v;
      else if (v) current.grafanaByUid.set(String(uid), v);
      else current.grafanaByUid.delete(String(uid));
    },
    navigate: (path, opts) => navigate(href(path), opts),
    href,
    grafanaLink
  };

  try {
    await mod.render(ctx);
    if (token !== seq) return;
    if (restore) window.scrollTo(0, scroll);
  } catch (e) {
    if (token !== seq || e.name === "AbortError") return;
    // 链接里的参数不对、登录过期、断网都是预料之中的情况，不算程序错误
    if (!e.badParam && !e.auth && !e.network) console.error(e);
    if (e.badParam) {
      render(view, ui.card(ui.empty(e.message, { icon: "help-circle-outline", title: "找不到这条记录", action: ui.button("返回", { href: href(route.parent || "/stats/"), kind: "soft" }) })));
    } else {
      render(view, ui.card(ui.error(e, () => show({ scroll: null }))));
    }
  } finally {
    if (token === seq) {
      view.style.minHeight = "";
      progress.done();
    }
  }
}

// ---------------------------------------------------------------- 启动

async function boot() {
  applyTheme();
  renderShell();
  if (!history.state) history.replaceState({ idx: 0 }, "");
  history.scrollRestoration = "manual";

  const m = match(location.pathname);
  const route = m && m.route;
  // 模块和数据并行取
  if (route) importPage(route.module).catch(() => {});
  renderHead({ title: route ? route.title : "统计", route, loading: true });
  render(viewEl, ui.skeleton(["stats", "list"]));
  progress.start();

  try {
    await api.init();
  } catch (e) {
    if (!e.auth && !e.network) console.error(e);
    progress.done();
    render(viewEl, ui.card(ui.error(e, () => boot())));
    return;
  }
  themeMode = api.settings.themeMode;
  store(THEME_KEY, themeMode);
  applyTheme();
  fmt.configure(api.settings);
  // URL 里指定了车就记住
  const carParam = new URLSearchParams(location.search).get("car");
  if (carParam && api.cars.some((c) => String(c.id) === carParam)) store(CAR_KEY, carParam);
  await show({ scroll: history.state.scroll || 0, restore: true });
}

boot();
