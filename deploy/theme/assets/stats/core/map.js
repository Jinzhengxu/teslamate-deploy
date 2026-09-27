/*
 * Leaflet 封装：
 *   - 第一次用到时才加载 vendor/leaflet-1.9.4（css + js）；
 *   - 底图用高德矢量瓦片（国内快）。高德用的是 GCJ-02 坐标，TeslaMate 存的是 WGS-84，
 *     所以这里所有接口都收 WGS-84 坐标，画之前统一转换（中国境外不转）；
 *   - 暗色主题给瓦片加 CSS 滤镜（stats.css），不用另一套瓦片；
 *   - 手势：触屏上单指留给页面滚动，双指缩放 / 平移地图；全屏后单指也能拖。
 *     桌面上照常拖动，滚轮缩放要先点一下地图（免得滚页面时误缩放）；
 *   - 离开页面自动 remove。
 *   - 内嵌地图最高占视口的比例：容器（.tm-map 或外层 .tm-map-wrap）上的 data-max-vh（ui.mapBox 的 maxVh 输出），默认 45。
 */
import { html, icon, render, onLeave, esc, isHtml } from "./ui.js";
import { loadError } from "./api.js";

const BASE = "/stats/vendor/leaflet-1.9.4/";
const TILES = "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}";

let loading = null;

function loadCss(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) return resolve();
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.onload = () => resolve();
    // 登录过期时 Caddy 回的是登录页：探一下，是 401 就显示「重新登录」
    l.onerror = () => loadError(href, new Error("地图样式加载失败")).then(reject);
    // 插在 stats.css 前面，让我们的样式（同样的优先级）盖过 Leaflet 默认样式
    const ours = document.querySelector('link[href$="stats.css"]');
    document.head.insertBefore(l, ours);
  });
}

function loadJs(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      loadError(src, new Error("地图组件加载失败，检查网络后重试")).then(reject);
    };
    document.head.appendChild(s);
  });
}

export function load() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (!loading) {
    loading = Promise.all([loadCss(BASE + "leaflet.css"), loadJs(BASE + "leaflet.js")]).then(
      () => window.L,
      (e) => {
        loading = null;
        throw e;
      }
    );
  }
  return loading;
}

export function L() {
  return window.L;
}

// ---------------------------------------------------------------- WGS-84 → GCJ-02

const A = 6378245.0;
const EE = 0.00669342162296594323;
const PI = Math.PI;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function transformLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return r;
}

// WGS-84 → GCJ-02，返回 [lat, lng]；中国境外原样返回
export function gcj(lat, lng) {
  lat = +lat;
  lng = +lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

function conv(p) {
  if (Array.isArray(p)) return gcj(p[0], p[1]);
  if (p && p.lat != null) return gcj(p.lat, p.lng ?? p.lon ?? p.longitude);
  if (p && p.latitude != null) return gcj(p.latitude, p.longitude);
  return null;
}

// ---------------------------------------------------------------- 主题颜色（地图上的线、点）

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue("--tm-" + name).trim() || name;
}

// 颜色参数：主题色名（accent green amber red violet cyan c1…c6）或 CSS 颜色
const THEMED = /^(accent|green|amber|red|violet|cyan|c[1-6]|text|text-2|surface)$/;

function paint(name) {
  return THEMED.test(name) ? cssColor(name) : name;
}

const themed = new Set();

function repaint(layer) {
  const s = layer.__tmStyle;
  layer.setStyle({ ...s, color: paint(s.color), fillColor: s.fillColor && paint(s.fillColor) });
}

window.addEventListener("tm-themechange", () => {
  for (const layer of themed) {
    if (!layer._map) {
      themed.delete(layer);
      continue;
    }
    repaint(layer);
  }
});

// 换主题时不在地图上的图层会被移出 themed（离开页面后的图层不能一直留着）。
// 这类图层（比如 cursor 的光标点第一次 show 之前、页面临时拿下又加回的图层）重新加到地图上时补登记，并按当前主题重新上色
function styled(layer, style) {
  layer.__tmStyle = style;
  themed.add(layer);
  layer.on("add", () => {
    if (themed.has(layer)) return;
    themed.add(layer);
    repaint(layer);
  });
  return layer;
}

// ---------------------------------------------------------------- 创建地图

const touchDevice = () => window.matchMedia("(pointer: coarse)").matches;

// el：.tm-map 元素或 id。opts：{ interactive = true, zoomControl = true, fullscreen = true, center: [lat, lng]（WGS）, zoom }
// 返回 Leaflet 地图；页面已经离开时返回 null
export async function create(el, { interactive = true, zoomControl = true, fullscreen = true, center, zoom = 12 } = {}) {
  const node = typeof el === "string" ? document.getElementById(el) : el;
  if (!node) throw new Error("地图容器不存在：" + el);
  const Lf = await load();
  if (!node.isConnected) return null;
  applyMaxVh(node);
  const touch = touchDevice();
  const m = Lf.map(node, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
    dragging: interactive && !touch,
    touchZoom: interactive,
    doubleClickZoom: interactive,
    boxZoom: false,
    keyboard: interactive,
    scrollWheelZoom: false,
    zoomSnap: 0.5,
    fadeAnimation: true,
    worldCopyJump: false
  });
  m.attributionControl.setPrefix(false);
  Lf.tileLayer(TILES, {
    subdomains: "1234",
    minZoom: 3,
    maxZoom: 18,
    maxNativeZoom: 18,
    attribution: "© 高德地图",
    crossOrigin: false
  }).addTo(m);
  const start = center ? conv(center) : [36.6512, 117.1201];
  m.setView(start, zoom);

  // 弹出框自动平移时躲开右上的全屏按钮（10 + 36px）和右下的缩放按钮（桌面才有）
  const hasZoom = interactive && zoomControl && !touch;
  m.__tmPopupPad = {
    autoPanPaddingTopLeft: [12, interactive && fullscreen ? 56 : 12],
    autoPanPaddingBottomRight: [hasZoom || (interactive && fullscreen) ? 56 : 12, 12]
  };
  m.__tmPins = new Set();
  // 右上的全屏按钮、右下的缩放按钮：fit 按它们留出右边一条
  m.__tmCtl = { zoom: hasZoom, fullscreen: interactive && fullscreen };

  if (interactive) {
    if (hasZoom) Lf.control.zoom({ position: "bottomright", zoomInTitle: "放大", zoomOutTitle: "缩小" }).addTo(m);
    // 滚轮缩放：点过地图才开，鼠标离开就关
    if (!touch) {
      m.on("click focus", () => m.scrollWheelZoom.enable());
      m.on("mouseout blur", () => m.scrollWheelZoom.disable());
    }
    if (fullscreen) addFullscreen(m, node, touch);
    if (touch) addTouchHint(m, node);
  }

  const ro = new ResizeObserver(() => m.invalidateSize());
  ro.observe(node);
  onLeave(() => {
    ro.disconnect();
    exitFullscreen();
    m.remove();
    // 换主题时要重设颜色的图层登记在模块级的 themed 里，地图删了也得一起清掉，
    // 否则每打开一次行程详情，那条上千个点的轨迹就一直留在内存里
    for (const layer of themed) if (!layer._map) themed.delete(layer);
  });
  return m;
}

// 容器上的 data-max-vh：内嵌时最高占视口的百分比（足迹页 60）。stats.css 里 .tm-map 的高度是
// min(var(--tm-map-h), var(--tm-map-max, 45vh))，这里只补上 CSS 变量 --tm-map-max（ui.mapBox 已经写了就不动），
// 不写内联 height：内联 height 会盖掉页面 CSS 里给地图定的高度
function applyMaxVh(node) {
  if (node.style.getPropertyValue("--tm-map-max")) return;
  const wrap = node.closest(".tm-map-wrap");
  const v = node.dataset.maxVh ?? (wrap && wrap.dataset.maxVh);
  const vh = v == null || v === "" ? NaN : +v;
  if (!(vh > 0 && vh <= 100)) return;
  node.style.setProperty("--tm-map-max", `${vh}vh`);
}

// ---------------------------------------------------------------- 全屏

let fullState = null;

function exitFullscreen() {
  if (fullState) fullState.exit();
}

function addFullscreen(m, node, touch) {
  const Lf = window.L;
  const wrap = node.closest(".tm-map-wrap") || node;
  const Ctl = Lf.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const box = Lf.DomUtil.create("div", "leaflet-bar tm-map-btn");
      const a = Lf.DomUtil.create("a", "", box);
      a.href = "#";
      a.setAttribute("role", "button");
      const sync = (on) => {
        render(a, html`${icon(on ? "fullscreen-exit" : "fullscreen")}`);
        a.title = on ? "退出全屏" : "全屏";
        a.setAttribute("aria-label", "全屏");
        a.setAttribute("aria-pressed", on ? "true" : "false");
      };
      sync(false);
      Lf.DomEvent.disableClickPropagation(box);
      const toggle = () => {
        if (fullState && fullState.map === m) fullState.exit(true);
        else enter();
      };
      Lf.DomEvent.on(a, "click", (e) => {
        Lf.DomEvent.preventDefault(e);
        toggle();
      });
      // 角色是按钮，空格也要能按（<a> 默认只认回车，空格会把页面往下滚一屏）
      a.addEventListener("keydown", (e) => {
        if (e.key !== " ") return;
        e.preventDefault();
        if (!e.repeat) toggle();
      });
      const onKey = (e) => {
        if (e.key === "Escape") fullState && fullState.exit(true);
      };
      function enter() {
        exitFullscreen();
        // 页面或 mapBox 可能在容器上写了内联的 max-height / height（maxVh），全屏时要让开，退出时原样恢复
        const saved = [];
        override(saved, node, "max-height", "none");
        override(saved, node, "height", "100%");
        if (wrap !== node) override(saved, wrap, "max-height", "none");
        wrap.classList.add("is-fullscreen");
        document.documentElement.classList.add("tm-map-full");
        if (touch) m.dragging.enable();
        m.scrollWheelZoom.enable();
        sync(true);
        document.addEventListener("keydown", onKey);
        // 全屏时地图盖住了整页，Tab 不能走到底下看不见的内容上：地图以外的都设成 inert
        const inerted = inertOutside(wrap);
        fullState = {
          map: m,
          // focus：用户自己退出（按钮、Esc）时焦点还给全屏按钮；离开页面时不动
          exit(focus = false) {
            for (const el of inerted) el.inert = false;
            wrap.classList.remove("is-fullscreen");
            for (const [el, prop, v, prio] of saved) {
              if (v) el.style.setProperty(prop, v, prio);
              else el.style.removeProperty(prop);
            }
            document.documentElement.classList.remove("tm-map-full");
            if (touch) m.dragging.disable();
            m.scrollWheelZoom.disable();
            sync(false);
            document.removeEventListener("keydown", onKey);
            fullState = null;
            if (m._container && m._container.isConnected) {
              m.invalidateSize();
              if (focus) a.focus({ preventScroll: true });
            }
          }
        };
        m.invalidateSize();
      }
      return box;
    }
  });
  new Ctl().addTo(m);
}

// el 以外的整页设成 inert：从 el 往上到 body，每一层的兄弟节点都设上（本来就是 inert 的不算）。返回设过的，退出时去掉
function inertOutside(el) {
  const out = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const parent = n.parentElement;
    if (!parent) break;
    for (const sib of parent.children) {
      if (sib === n || sib.inert || sib.tagName === "SCRIPT" || sib.tagName === "LINK") continue;
      sib.inert = true;
      out.push(sib);
    }
  }
  return out;
}

// 临时改一条内联样式（!important），原来的值记进 saved 以便恢复
function override(saved, el, prop, value) {
  saved.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  el.style.setProperty(prop, value, "important");
}

// 触屏上单指按住地图拖动时，提示「双指移动地图」（页面照常滚动）
function addTouchHint(m, node) {
  const hint = document.createElement("div");
  hint.className = "tm-map-hint";
  hint.textContent = "双指移动、缩放地图";
  node.appendChild(hint);
  let timer = 0;
  let startY = 0;
  let startX = 0;
  node.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );
  node.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1 || m.dragging.enabled()) return;
      // 竖着滑是在滚页面，不打扰；横着拖才像是想挪地图
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx < 24 || dx < dy * 1.5) return;
      hint.classList.add("is-shown");
      clearTimeout(timer);
      timer = setTimeout(() => hint.classList.remove("is-shown"), 1200);
    },
    { passive: true }
  );
}

// ---------------------------------------------------------------- 图层（坐标一律 WGS-84）

function latlngs(points) {
  const out = [];
  for (const p of points || []) {
    const c = conv(p);
    if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) out.push(c);
  }
  return out;
}

// 轨迹：points = [[lat, lng], …]（或 { lat, lng } / { latitude, longitude }）
// 下面垫一条描边（亮色白、暗色深），线在花哨的底图上也醒目
export function track(m, points, { color = "accent", weight = 4, outline = true, opacity = 1 } = {}) {
  const Lf = window.L;
  const ll = latlngs(points);
  const group = Lf.featureGroup();
  if (ll.length < 2) return group.addTo(m);
  if (outline) {
    // 描边用卡片底色：亮色下是白边，暗色下是深色边（白边在暗色地图上太刺眼）
    const os = { color: "surface", weight: weight + 3, opacity: 0.85 };
    styled(Lf.polyline(ll, { ...os, color: paint("surface"), lineCap: "round", lineJoin: "round", interactive: false }), os).addTo(group);
  }
  const style = { color, weight, opacity };
  styled(Lf.polyline(ll, { ...style, color: paint(color), lineCap: "round", lineJoin: "round" }), style).addTo(group);
  return group.addTo(m);
}

const PIN = {
  start: { cls: "is-start", text: "起" },
  end: { cls: "is-end", text: "终" },
  charge: { cls: "is-charge", icon: "lightning-bolt" }
};

// 标记：kind = 'start' | 'end' | 'charge' | 'dot'；title：悬停 / 读屏文字；popup：点开显示的内容（文本或 Html）
export function marker(m, point, { kind = "dot", title, popup, zIndexOffset } = {}) {
  const Lf = window.L;
  const c = conv(point);
  if (!c || !Number.isFinite(c[0])) return null;
  let ic;
  if (kind === "dot") {
    ic = Lf.divIcon({ className: "tm-dot", iconSize: [16, 16], iconAnchor: [8, 8], html: "" });
  } else {
    const p = PIN[kind] || PIN.start;
    const inner = p.icon ? icon(p.icon).s : esc(p.text);
    ic = Lf.divIcon({
      className: "tm-pin " + p.cls,
      iconSize: [28, 38],
      iconAnchor: [14, 38],
      popupAnchor: [0, -34],
      html: `<span class="tm-pin-body">${inner}</span>`
    });
  }
  const mk = Lf.marker(c, {
    icon: ic,
    title: title || "",
    alt: title || "",
    keyboard: !!(title || popup),
    zIndexOffset: zIndexOffset ?? (kind === "end" ? 200 : kind === "start" ? 100 : 0),
    riseOnHover: true
  });
  if (popup != null) mk.bindPopup(isHtml(popup) ? popup.s : esc(popup), { closeButton: false, maxWidth: 260, ...popupPad(m) });
  if (kind !== "dot" && m.__tmPins) m.__tmPins.add(mk);
  return mk.addTo(m);
}

function popupPad(m) {
  return m.__tmPopupPad || { autoPanPaddingTopLeft: [12, 12], autoPanPaddingBottomRight: [12, 12] };
}

// 一堆圆点（足迹、地点热力）：points = [[lat, lng, 权重?], …]。radius 可以是函数 (权重, 点) => 像素
export function circles(m, points, { radius = 5, color = "accent", opacity = 0.55, stroke = false, popup } = {}) {
  const Lf = window.L;
  const group = Lf.featureGroup();
  // 最大的圆有多大：fit 的留白要把它算进去，不然边上的大圆被切掉一半
  group.__tmMaxRadius = 0;
  for (const p of points || []) {
    const c = conv(p);
    if (!c || !Number.isFinite(c[0])) continue;
    const w = Array.isArray(p) ? p[2] : p.weight;
    const r = typeof radius === "function" ? radius(w, p) : radius;
    if (r > group.__tmMaxRadius) group.__tmMaxRadius = r;
    const style = { color, fillColor: color, fillOpacity: opacity, weight: stroke ? 1.5 : 0, opacity: stroke ? 0.9 : 0 };
    const cm = styled(Lf.circleMarker(c, { ...style, color: paint(color), fillColor: paint(color), radius: r, stroke }), style);
    if (popup) {
      const content = popup(p);
      if (content != null) cm.bindPopup(isHtml(content) ? content.s : esc(content), { closeButton: false, ...popupPad(m) });
    }
    cm.addTo(group);
  }
  return group.addTo(m);
}

const PIN_H = 38;

// 地图右边控件（全屏、缩放按钮）连同 10px 边距占多宽；没有控件是 0。地图还没排版（量出来是 0）时按 34px 的按钮算
function controlStrip(m) {
  const ctl = m.__tmCtl;
  if (!ctl || !(ctl.zoom || ctl.fullscreen)) return 0;
  let w = 0;
  for (const el of m.getContainer().querySelectorAll(".leaflet-right .leaflet-control:not(.leaflet-control-attribution)")) w = Math.max(w, el.offsetWidth);
  return (w || 34) + 10;
}

// 把视野调到能看全这些图层（或 WGS 坐标数组）。
// 留白四边默认各 padding；地图上有起 / 终 / 充电图钉（38px 高、尖在点上）落在范围里时，顶部至少 44；
// 目标里有 circles 时，四边至少「最大半径 + 8」。
// 右上的全屏按钮、右下的缩放按钮都靠右：右边再让出控件那一条，圆、图钉、轨迹端点就不会压在按钮底下（只加右边，
// 上下还是原来的留白，不然窄地图上三面都缩进去太多）。paddingTopLeft / paddingBottomRight（[x, y]）直接给就照用
export function fit(m, target, { padding = 28, maxZoom = 16, paddingTopLeft, paddingBottomRight } = {}) {
  const Lf = window.L;
  let bounds = null;
  let maxR = 0;
  const add = (b) => {
    if (!b || !b.isValid || !b.isValid()) return;
    bounds = bounds ? bounds.extend(b) : Lf.latLngBounds(b.getSouthWest(), b.getNorthEast());
  };
  for (const t of Array.isArray(target) && !(typeof target[0] === "number") ? target : [target]) {
    if (!t) continue;
    if (t.__tmMaxRadius > maxR) maxR = t.__tmMaxRadius;
    if (t.getBounds) add(t.getBounds());
    else if (t.getLatLng) add(Lf.latLngBounds([t.getLatLng(), t.getLatLng()]));
    else if (Array.isArray(t) && typeof t[0] === "number") add(Lf.latLngBounds([conv(t), conv(t)]));
    else if (t.isValid) add(t);
  }
  if (!bounds) return bounds;
  let [l, t, r, b] = [padding, padding, padding, padding];
  if (maxR) {
    const e = maxR + 8;
    [l, t, r, b] = [Math.max(l, e), Math.max(t, e), Math.max(r, e), Math.max(b, e)];
  }
  const pins = m.__tmPins ? [...m.__tmPins].filter((mk) => mk._map === m && bounds.contains(mk.getLatLng())) : [];
  if (pins.length) {
    t = Math.max(t, PIN_H + 6);
    l = Math.max(l, 20);
    r = Math.max(r, 20);
  }
  // 控件那一条之外，再留出半个图钉（14px）或最大的圆，外加 6px 间隙
  const strip = controlStrip(m);
  if (strip) r = Math.max(r, strip + Math.max(pins.length ? 14 : 0, maxR) + 6);
  // 地图很小时留白别超过一半，不然 fitBounds 算出来的缩放级别是负的
  const size = m.getSize();
  const k = size.x > 0 && size.y > 0 ? Math.min(1, (size.x * 0.5) / Math.max(1, l + r), (size.y * 0.5) / Math.max(1, t + b)) : 1;
  const tl = paddingTopLeft || [Math.round(l * k), Math.round(t * k)];
  const br = paddingBottomRight || [Math.round(r * k), Math.round(b * k)];
  m.fitBounds(bounds, { paddingTopLeft: tl, paddingBottomRight: br, maxZoom, animate: false });
  return bounds;
}

// 曲线和地图联动用的光标点：cursor(m).show([lat, lng]（WGS）) / hide()。颜色跟主题（默认 c2 橙，白 / 深色描边）
export function cursor(m, { color = "c2", radius = 7 } = {}) {
  const Lf = window.L;
  const style = { color: "surface", fillColor: color, weight: 3, opacity: 0, fillOpacity: 0 };
  const layer = styled(
    Lf.circleMarker([0, 0], { ...style, color: paint("surface"), fillColor: paint(color), radius, interactive: false }),
    style
  );
  let shown = false;
  const set = (on) => {
    shown = on;
    style.opacity = on ? 1 : 0;
    style.fillOpacity = on ? 1 : 0;
    layer.setStyle({ opacity: style.opacity, fillOpacity: style.fillOpacity });
  };
  return {
    layer,
    show(point) {
      const c = point == null ? null : conv(point);
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return this.hide();
      // 地图已经删掉（离开页面）时什么也不做
      if (!m._mapPane) return;
      if (!layer._map) layer.addTo(m);
      layer.setLatLng(c);
      if (!shown) set(true);
    },
    hide() {
      if (shown) set(false);
    }
  };
}

// ---------------------------------------------------------------- 轨迹切段

function km(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 一行轨迹点 → [毫秒, lat, lng]：{ time | date, lat, lng } / { latitude, longitude } / [ms, lat, lng]
function rowPoint(r) {
  if (Array.isArray(r)) return [+r[0], r[1], r[2]];
  if (!r) return null;
  return [+(r.time ?? r.date), r.lat ?? r.latitude, r.lng ?? r.lon ?? r.longitude];
}

// rows 按时间排好，返回若干段 [[lat, lng], …]（WGS-84）。
// 把所有点连成一条线的话，TeslaMate 停机期间车开走了（库里没记录）时会凭空画出一条直线穿过地图。所以两种情况断开：
// 隔了 gapMin 分钟以上而且位置变了 maxJumpKm 以上；或者快得不可能（超过 maxJumpKm + 每分钟 5 km，坐标跳变）。
// 少于两个点的段丢掉（画不成线）
export function splitTrack(rows, { gapMin = 10, maxJumpKm = 1 } = {}) {
  const segs = [];
  let cur = [];
  let prev = null;
  for (const r of rows || []) {
    const q = rowPoint(r);
    if (!q || q[1] == null || q[2] == null) continue;
    const p = [+q[1], +q[2]];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (prev) {
      const dt = (q[0] - prev.time) / 60e3;
      const d = km(prev.p, p);
      if ((dt > gapMin && d > maxJumpKm) || d > maxJumpKm + Math.max(dt, 0) * 5) {
        if (cur.length > 1) segs.push(cur);
        cur = [];
      }
    }
    cur.push(p);
    prev = { time: q[0], p };
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

// 按时间切段后的多段轨迹，合成一条多段 polyline 画（再加一条描边），几千段也只有两个图层。
// rows：[{ time, lat, lng }] 或 [[ms, lat, lng]]（WGS-84，按时间排好）。返回 featureGroup，group.segments 是切好的段（WGS）
export function tracks(m, rows, { color = "accent", weight = 4, outline = true, opacity = 1, gapMin, maxJumpKm } = {}) {
  const Lf = window.L;
  const segs = splitTrack(rows, { gapMin, maxJumpKm });
  const group = Lf.featureGroup();
  group.segments = segs;
  const ll = segs.map(latlngs).filter((s) => s.length > 1);
  if (!ll.length) return group.addTo(m);
  if (outline) {
    const os = { color: "surface", weight: weight + 3, opacity: 0.85 };
    styled(Lf.polyline(ll, { ...os, color: paint("surface"), lineCap: "round", lineJoin: "round", interactive: false }), os).addTo(group);
  }
  const style = { color, weight, opacity };
  styled(Lf.polyline(ll, { ...style, color: paint(color), lineCap: "round", lineJoin: "round" }), style).addTo(group);
  return group.addTo(m);
}
