/*
 * html`` 模板 + 公共组件。组件都返回 Html 片段（html`` 的结果），可以互相嵌套，最后用 render(el, 片段) 画出来。
 *
 * 安全：html`` 里的插值默认做 HTML 转义，所以数据库里的地址、地名、车名直接插进去就是安全的。
 * 只有 raw() 包过的字符串才原样输出 —— 只给自己写死的、可信的 HTML 用。
 * 属性里也会转义引号，但 href / style / on* 这类属性不要放数据库文本（转义挡不住 javascript: 链接）。
 */
import { ICONS } from "./icons.js";
import * as fmt from "./format.js";

// ---------------------------------------------------------------- 模板

class Html {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function raw(str) {
  return str instanceof Html ? str : new Html(str == null ? "" : String(str));
}

export function isHtml(v) {
  return v instanceof Html;
}

function part(v) {
  // null / undefined / false / true 都不输出，方便写 cond && html`…`
  if (v == null || v === false || v === true) return "";
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Html(out);
}

// 把片段画进元素（整体替换内容）。tpl 可以是 Html、字符串（会转义）或数组
export function render(el, tpl) {
  el.innerHTML = part(tpl);
  hydrate(el);
  return el;
}

// 画完之后要挂 JS 的公共部件（现在只有宽表格的滚动渐隐）。render 和 pager 追加时自动调用；
// 页面自己用 innerHTML / insertAdjacentHTML 插的表格没有渐隐提示，别的照常
function hydrate(el) {
  if (!fadeRO || !el.querySelectorAll) return;
  for (const w of el.querySelectorAll(".tm-table-wrap")) {
    fadeRO.observe(w);
    if (w.firstElementChild) fadeRO.observe(w.firstElementChild);
  }
}

// 属性串：{ "data-x": 1, "aria-label": "…" } → ` data-x="1" aria-label="…"`（值会转义；null / false 跳过，true 输出空值）。
// allow 给了就只放行匹配的名字（列表项只收 data-* / aria-*，免得页面把 href、style、on* 这类塞进来）
function attrStr(attrs, allow) {
  if (!attrs) return raw("");
  return raw(
    Object.entries(attrs)
      .filter(([k, v]) => {
        if (v == null || v === false) return false;
        if (!/^[a-zA-Z_:][\w:.-]*$/.test(k) || (allow && !allow.test(k))) {
          console.warn("[stats] 忽略属性：" + k);
          return false;
        }
        return true;
      })
      .map(([k, v]) => ` ${k}="${esc(v === true ? "" : v)}"`)
      .join("")
  );
}

// 按 id 登记的回调（筛选条、延迟生成的展开面板）：Html 片段里放不了函数，只能放 id。
// 页面离开时一起清掉；页面之外登记的只留最近 200 个
function keep(map, id, value) {
  map.set(id, value);
  if (scope) scope.push(() => map.delete(id));
  else if (map.size > 200) map.delete(map.keys().next().value);
}

let seqN = 0;
const uid = (p) => `tm-${p}${++seqN}`;

// ---------------------------------------------------------------- 页面生命周期
// chart.js / map.js 创建的实例登记到「当前页面」，离开页面时由 app.js 统一销毁

let scope = null;

export function _setScope(list) {
  scope = list;
}

export function onLeave(fn) {
  if (scope) scope.push(fn);
  else console.warn("[stats] onLeave 在页面之外调用，不会自动清理");
}

// ---------------------------------------------------------------- 图标

// name 是 icons.js 里的名字，或直接是 SVG path 数据（以 M 开头）
export function icon(name, { size, cls, label } = {}) {
  const d = ICONS[name] || (/^[Mm]/.test(name || "") ? name : null);
  if (!d) {
    console.warn("[stats] 没有这个图标：" + name);
    return raw("");
  }
  const style = size ? ` style="width:${+size}px;height:${+size}px"` : "";
  const a11y = label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"';
  return raw(
    `<svg class="tm-svg${cls ? " " + esc(cls) : ""}" viewBox="0 0 24 24"${style}${a11y} focusable="false"><path d="${esc(d)}"/></svg>`
  );
}

// ---------------------------------------------------------------- 语气色

const TONES = { accent: "accent", blue: "accent", good: "green", green: "green", warn: "amber", amber: "amber", bad: "red", red: "red", violet: "violet", purple: "violet", cyan: "cyan", muted: "muted" };

function tone(t) {
  return (t && TONES[t]) || "";
}

// ---------------------------------------------------------------- 结构

// 带小标题的分组。action：Html 片段，或 { href, label }
export function section(title, body, { action, sub, id } = {}) {
  let act = "";
  if (action && !(action instanceof Html) && action.href) {
    act = html`<a class="tm-section-action" href="${action.href}">${action.label || "全部"}</a>`;
  } else if (action) {
    act = html`<div class="tm-section-action">${action}</div>`;
  }
  return html`<section class="tm-section"${id ? raw(` id="${esc(id)}"`) : ""}>
    ${title || act ? html`<div class="tm-section-head"><h2 class="tm-section-title">${title}</h2>${act}</div>` : ""}
    ${sub ? html`<p class="tm-section-sub">${sub}</p>` : ""}
    ${body}
  </section>`;
}

// 白底圆角卡片。pad：是否留内边距（列表、图表铺满时传 false）；href：整张卡片可点；
// attrs：额外属性（如 { "data-tm-append": "list" }，给 pager 合并用）
export function card(body, { pad = true, href, cls, title, attrs } = {}) {
  const c = `tm-card${pad ? " is-pad" : ""}${cls ? " " + cls : ""}`;
  const a = attrStr(attrs);
  const inner = html`${title ? html`<h3 class="tm-card-title">${title}</h3>` : ""}${body}`;
  return href ? html`<a class="${c}" href="${href}"${a}>${inner}</a>` : html`<div class="${c}"${a}>${inner}</div>`;
}

export function button(label, { href, kind, icon: ic, small, attrs = {} } = {}) {
  const c = `tm-btn${kind ? " is-" + kind : ""}${small ? " is-small" : ""}`;
  const a = attrStr(attrs);
  const inner = html`${ic ? icon(ic) : ""}<span>${label}</span>`;
  return href
    ? html`<a class="${c}" href="${href}"${a}>${inner}</a>`
    : html`<button type="button" class="${c}"${a}>${inner}</button>`;
}

// ---------------------------------------------------------------- 统计数字宫格

// items: [{ label, value, unit, sub, tone, icon, href, digits }]
// value 是数字时按 digits 位小数格式化（默认 0），字符串原样显示，null → —
export function stats(items, { cols } = {}) {
  const cells = items.filter(Boolean).map((it) => {
    const v = typeof it.value === "number" ? fmt.num(it.value, it.digits ?? 0) : it.value == null || it.value === "" ? "—" : it.value;
    const body = html`
      <div class="tm-stat-label">${it.icon ? icon(it.icon) : ""}<span class="tm-truncate">${it.label}</span></div>
      <div class="tm-stat-value${tone(it.tone) ? " tm-tone-" + tone(it.tone) : ""}"><span>${v}</span>${
        it.unit && v !== "—" ? html`<span class="tm-stat-unit">${it.unit}</span>` : ""
      }</div>
      ${it.sub != null && it.sub !== "" ? html`<div class="tm-stat-sub">${it.sub}</div>` : ""}`;
    return it.href ? html`<a class="tm-stat" href="${it.href}">${body}</a>` : html`<div class="tm-stat">${body}</div>`;
  });
  return html`<div class="tm-stats${cols ? " is-" + cols : ""}">${cells}</div>`;
}

// ---------------------------------------------------------------- 列表

// items: [{ href, title, sub, meta, value, valueSub, icon, tone, chevron, titleLines, attrs, expand, expanded }]
// 放在卡片里：ui.card(ui.list(items), { pad: false })。opts.more：{ href, label } 底部「查看全部」
//   标题默认最多两行（超充站这类名字能区分的部分在末尾）；titleLines: 1 单行省略
//   attrs：行上的 data-* / aria-* 属性
//   expand：Html 或 () => Html（第一次展开时才生成）。有它的行是「点一下展开」的按钮行，下面接一个隐藏面板；
//   expanded: true 一开始就展开。展开行不能同时是链接（有 expand 时忽略 href）
const LIST_ATTRS = /^(data-[\w.-]+|aria-[a-z]+|title|id)$/;
const lazyPanels = new Map();

export function list(items, { more } = {}) {
  const rows = items.filter(Boolean).map((it) => {
    const t = tone(it.tone);
    const exp = it.expand != null && it.expand !== false && it.expand !== "";
    if (exp && it.href) console.warn("[stats] 列表行同时有 expand 和 href，按展开行画");
    const href = exp ? null : it.href;
    const body = html`
      ${it.icon ? html`<span class="tm-row-icon${t ? " is-" + t : ""}">${icon(it.icon)}</span>` : ""}
      <div class="tm-row-main">
        <div class="tm-row-title${it.titleLines === 1 ? " is-1" : ""}">${it.title}</div>
        ${it.sub != null && it.sub !== "" ? html`<div class="tm-row-sub">${it.sub}</div>` : ""}
        ${it.meta != null && it.meta !== "" ? html`<div class="tm-row-meta">${it.meta}</div>` : ""}
      </div>
      ${it.value != null || it.valueSub != null
        ? html`<div class="tm-row-end">
            ${it.value != null ? html`<div class="tm-row-value">${it.value}</div>` : ""}
            ${it.valueSub != null ? html`<div class="tm-row-value-sub">${it.valueSub}</div>` : ""}
          </div>`
        : ""}
      ${exp
        ? icon("chevron-down", { cls: "tm-row-expand-icon" })
        : href && it.chevron !== false
          ? icon("chevron-right", { cls: "tm-row-chevron" })
          : ""}`;
    const c = `tm-row${it.icon ? " has-icon" : ""}${exp ? " is-expand" : ""}`;
    const a = attrStr(it.attrs, LIST_ATTRS);
    if (exp) {
      const pid = uid("rp");
      const open = !!it.expanded;
      let content = it.expand;
      if (typeof content === "function") {
        if (open) content = content();
        else {
          keep(lazyPanels, pid, content);
          content = "";
        }
      }
      return html`<div class="${c}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" aria-controls="${pid}" data-tm-expand${a}>${body}</div><div class="tm-row-panel" id="${pid}"${open ? "" : raw(" hidden")}>${content}</div>`;
    }
    return href ? html`<a class="${c}" href="${href}"${a}>${body}</a>` : html`<div class="${c}"${a}>${body}</div>`;
  });
  return html`<div class="tm-list">${rows}${
    more ? html`<a class="tm-list-more" href="${more.href}">${more.label || "查看全部"}</a>` : ""
  }</div>`;
}

// 展开 / 收起一行（open 不给就切换）。页面一般不用调，点击和键盘（回车、空格）核心已经处理
export function expandRow(row, open) {
  if (!row || !row.hasAttribute("data-tm-expand")) return;
  const panel = document.getElementById(row.getAttribute("aria-controls"));
  if (!panel) return;
  const next = open == null ? row.getAttribute("aria-expanded") !== "true" : !!open;
  if (next && lazyPanels.has(panel.id)) {
    const fn = lazyPanels.get(panel.id);
    lazyPanels.delete(panel.id);
    render(panel, fn());
  }
  panel.hidden = !next;
  row.setAttribute("aria-expanded", next ? "true" : "false");
}

document.addEventListener("click", (e) => {
  const row = e.target.closest && e.target.closest("[data-tm-expand]");
  if (!row) return;
  // 行里的链接、按钮照常工作，不顺带展开
  const inner = e.target.closest("a, button, input, select, label, textarea");
  if (inner && row.contains(inner)) return;
  expandRow(row);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest && e.target.closest("[data-tm-expand]");
  if (!row || e.target !== row) return;
  e.preventDefault();
  expandRow(row);
});

// ---------------------------------------------------------------- 表格

// columns: [{ key, label, align: "right"|"center", fmt: (v, row) => 文本|Html, primary, wrap, mobile: false }]
// 宽屏是表格；手机上默认每行变成一块卡片（primary 列当标题，其余「标签 … 值」）。
// mobile: "table" 时手机上仍是表格（小字号、小内边距，放不下就横向滚动），适合行多、列少而短的表（气温分档这种）。
// 列上 mobile: false 在手机上隐藏（两种模式都是）。能横向滚动时右边缘渐隐，提示右边还有。
// rowHref(row) 给了就整行可点（第一列渲染成链接，键盘也能到）。放在 ui.card(…, { pad: false }) 里。
export function table({ columns, rows, dense, rowHref, empty: emptyText, mobile = "cards" } = {}) {
  if (!rows || !rows.length) return empty(emptyText || "没有数据");
  const mt = mobile === "table" ? " is-mobile-table" : "";
  const cols = columns.filter(Boolean);
  const primaryKey = (cols.find((c) => c.primary) || cols[0]).key;
  const cellClass = (c) =>
    [c.align === "right" ? "is-right" : c.align === "center" ? "is-center" : "", c.wrap ? "is-wrap" : "", c.key === primaryKey ? "is-primary" : "", c.mobile === false ? "is-mobile-hidden" : ""]
      .filter(Boolean)
      .join(" ");
  const head = html`<thead><tr>${cols.map((c) => html`<th class="${cellClass(c)}" scope="col">${c.label}</th>`)}</tr></thead>`;
  const body = rows.map((row) => {
    const href = rowHref ? rowHref(row) : null;
    const cells = cols.map((c) => {
      const v = c.fmt ? c.fmt(row[c.key], row) : row[c.key];
      const shown = v == null || v === "" ? "—" : v;
      const content = href && c.key === primaryKey ? html`<a href="${href}">${shown}</a>` : shown;
      return html`<td class="${cellClass(c)}" data-label="${typeof c.label === "string" ? c.label : ""}">${content}</td>`;
    });
    return html`<tr${href ? raw(` data-href="${esc(href)}"`) : ""}>${cells}</tr>`;
  });
  return html`<div class="tm-table-wrap${mt}"><table class="tm-table${dense ? " is-dense" : ""}${mt}">${head}<tbody>${body}</tbody></table></div>`;
}

// 宽表格的渐隐提示：能横向滚动时标上 is-scrollable，滚到两头时标 is-start / is-end（CSS 按这些类加遮罩）。
// 尺寸变化用一个共享的 ResizeObserver 看（表格和它的外框都看：字体加载完表格变宽、转屏外框变窄），
// 滚动用 document 上的捕获监听，不给每个表格单独挂
function updateFade(w) {
  const max = w.scrollWidth - w.clientWidth;
  w.classList.toggle("is-scrollable", max > 1);
  w.classList.toggle("is-start", w.scrollLeft <= 1);
  w.classList.toggle("is-end", w.scrollLeft >= max - 1);
}

const fadeRO =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        for (const en of entries) {
          const w = en.target.classList.contains("tm-table-wrap") ? en.target : en.target.parentElement;
          if (!w || !w.isConnected) {
            // 离开页面后表格被移除，尺寸变成 0 时会最后通知一次：借这次解除观察
            fadeRO.unobserve(en.target);
            continue;
          }
          updateFade(w);
        }
      })
    : null;

document.addEventListener(
  "scroll",
  (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("tm-table-wrap")) updateFade(t);
  },
  { capture: true, passive: true }
);

// 整行点击：交给行里的链接（路由会接住站内链接）
document.addEventListener("click", (e) => {
  const tr = e.target.closest && e.target.closest("tr[data-href]");
  if (!tr || e.target.closest("a, button, input, select, label")) return;
  const a = tr.querySelector("a[href]");
  if (a) a.click();
});

// ---------------------------------------------------------------- 分段选择

// options: ["day", …] 或 [{ value, label }]。配合 onSegment(root, name, fn) 使用
// prefix / suffix：选项前后的可见文字，做成「只算单次超过 [1 5 10] km」这种筛选行（后缀和选项不拆开，前缀放不下时自己占一行）。
// label（屏幕阅读器读的组名）不给时用 prefix + suffix 拼。
// value 不在选项里时（比如范围不是任何一个快捷档）没有选中项，第一个按钮可以用 Tab 进去
export function segmented(name, options, value, { full, label, prefix, suffix } = {}) {
  const opts = options.map((o) => (typeof o === "object" ? o : { value: o, label: o }));
  const has = opts.some((o) => String(o.value) === String(value));
  const text = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  const aria = label || [text(prefix), text(suffix) && `（${text(suffix)}）`].filter(Boolean).join("");
  const seg = html`<div class="tm-seg${full ? " is-full" : ""}" role="radiogroup" data-seg="${name}"${aria ? raw(` aria-label="${esc(aria)}"`) : ""}>${opts.map((o, i) => {
    const on = String(o.value) === String(value);
    return html`<button type="button" role="radio" data-value="${o.value}" aria-checked="${on ? "true" : "false"}" tabindex="${on || (!has && i === 0) ? "0" : "-1"}">${o.label}</button>`;
  })}</div>`;
  const affix = (v) => (v != null && v !== "" && v !== false ? html`<span class="tm-seg-affix">${v}</span>` : "");
  if (!affix(prefix) && !affix(suffix)) return seg;
  return html`<div class="tm-seg-line${full ? " is-full" : ""}">${affix(prefix)}<span class="tm-seg-tail">${seg}${affix(suffix)}</span></div>`;
}

// 事件委托：root 里名为 name 的分段选择被点时调用 fn(value)。返回解绑函数
export function onSegment(root, name, fn) {
  const sel = `.tm-seg[data-seg="${CSS.escape(name)}"]`;
  const pick = (btn) => {
    const seg = btn.closest(sel);
    for (const b of seg.querySelectorAll("[data-value]")) {
      const on = b === btn;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    fn(btn.dataset.value);
  };
  const onClick = (e) => {
    const btn = e.target.closest(`${sel} [data-value]`);
    if (btn && btn.getAttribute("aria-checked") !== "true") pick(btn);
  };
  const onKey = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const btn = e.target.closest(`${sel} [data-value]`);
    if (!btn) return;
    const all = [...btn.parentElement.querySelectorAll("[data-value]")];
    const next = all[(all.indexOf(btn) + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next.focus();
    pick(next);
    e.preventDefault();
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKey);
  };
}

// ---------------------------------------------------------------- 小部件

export function pill(text, t, { icon: ic } = {}) {
  const c = tone(t);
  return html`<span class="tm-pill${c ? " is-" + c : ""}">${ic ? icon(ic) : ""}${text}</span>`;
}

// 横向进度条（排行榜）：value / max
export function bar(value, max, t) {
  const pct = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const c = tone(t);
  return html`<div class="tm-bar${c ? " is-" + c : ""}" role="presentation"><span style="width:${pct.toFixed(2)}%"></span></div>`;
}

// 键值对：[[k, v], …]，v 可以是 Html。cols: 2 时桌面上排两列
export function kv(pairs, { cols } = {}) {
  return html`<dl class="tm-kv${cols === 2 ? " is-2" : ""}">${pairs
    .filter(Boolean)
    .map(([k, v]) => html`<div><dt>${k}</dt><dd>${v == null || v === "" ? "—" : v}</dd></div>`)}</dl>`;
}

// 图表外面的简单图例（ECharts 自带图例也能用，这个更省地方）：[{ label, color }]，color 用 CSS 颜色或 var(--tm-c1)
export function legend(items) {
  return html`<div class="tm-chart-legend">${items.map(
    (it) => html`<span><i style="color:${it.color}"></i>${it.label}</span>`
  )}</div>`;
}

const present = (x) => x != null && x !== false && x !== true && x !== "";

// 一行放得下几项就显示几项，放不下的整项藏起来（不会截出半截字）：列表行的 sub / meta 在窄屏上用。
// items 按重要程度从左到右排（null / false 跳过），先藏最后面的；第一项自己就放不下时才省略号截断。
// sep: true 时项之间加「·」（默认靠 10px 间距分开，适合每项前面带小图标的写法）
export function fit(items, { sep, cls } = {}) {
  return html`<span class="tm-fit-line${sep ? " is-sep" : ""}${cls ? " " + cls : ""}">${items
    .filter(present)
    .map((x) => html`<span>${x}</span>`)}</span>`;
}

// 分段文字：按段折行，段与段之间「 · 」，折到下一行时行首不带「·」（「新车 520 km · 少 38 km」这种）
export function segs(items, { cls } = {}) {
  return html`<span class="tm-segs${cls ? " " + cls : ""}">${items.filter(present).map((x) => html`<span>${x}</span>`)}</span>`;
}

// 折叠区（原生 details / summary）：「进阶」「这些数字是怎么算的」这类默认收起的内容。
// opts：{ open, sub（标题下一行小字）, icon, id, cls, card = true（false 时不带卡片外框，放在别的卡片里用） }
export function details(title, body, { open, sub, icon: ic, id, cls, card: asCard = true } = {}) {
  const c = `tm-details${asCard ? " tm-card" : ""}${cls ? " " + cls : ""}`;
  return html`<details class="${c}"${id ? raw(` id="${esc(id)}"`) : ""}${open ? raw(" open") : ""}>
    <summary>${ic ? icon(ic, { cls: "tm-details-icon" }) : ""}<span class="tm-details-head"><span class="tm-details-title">${title}</span>${
      present(sub) ? html`<span class="tm-details-sub">${sub}</span>` : ""
    }</span>${icon("chevron-down", { cls: "tm-details-chev" })}</summary>
    <div class="tm-details-body">${body}</div>
  </details>`;
}

// 排行榜：名次徽标、名字（最多两行）、数值、横条、小字。超过 shown 条时先收起，底下「展开全部 N 个」。
// items：[{ name, value, text, sub, href, tone }]，text 不给就是 fmt.num(value, digits) + unit；
// opts：{ tone = "accent", shown = 5（0 = 全部显示）, unit, digits = 0, max（横条满格的值，默认最大值）, noun = "个", empty }
export function rank(items, { tone: t = "accent", shown = 5, unit, digits = 0, max, noun = "个", empty: emptyText } = {}) {
  const rows = items.filter(Boolean);
  if (!rows.length) return empty(emptyText || "没有数据。");
  const top = max != null ? max : Math.max(0, ...rows.map((r) => +r.value || 0));
  const lim = shown > 0 ? shown : rows.length;
  const id = uid("rank");
  const li = (r, i) => {
    const text = r.text != null ? r.text : r.value == null ? "—" : `${fmt.num(r.value, digits)}${unit ? " " + unit : ""}`;
    const tip = typeof r.name === "string" ? raw(` title="${esc(r.name)}"`) : "";
    const name = r.href
      ? html`<a class="tm-rank-name" href="${r.href}"${tip}>${r.name}</a>`
      : html`<span class="tm-rank-name"${tip}>${r.name}</span>`;
    return html`<li class="tm-rank-row"${i >= lim ? raw(" hidden") : ""}>
      <span class="tm-rank-no${i < 3 ? " is-top" : ""}">${r.rank != null ? r.rank : i + 1}</span>
      <div class="tm-rank-main">
        <div class="tm-rank-head">${name}<span class="tm-rank-value tm-num">${text}</span></div>
        ${bar(+r.value || 0, top, r.tone || t)}
        ${present(r.sub) ? html`<div class="tm-rank-sub">${r.sub}</div>` : ""}
      </div>
    </li>`;
  };
  return html`<div class="tm-rank-box"><ol class="tm-rank" id="${id}">${rows.map(li)}</ol>${
    rows.length > lim
      ? html`<button type="button" class="tm-btn is-small is-text tm-rank-more" data-tm-rank-more="${lim}" data-label="展开全部 ${rows.length} ${noun}" aria-controls="${id}" aria-expanded="false">展开全部 ${rows.length} ${noun}</button>`
      : ""
  }</div>`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("[data-tm-rank-more]");
  if (!btn) return;
  const list = document.getElementById(btn.getAttribute("aria-controls"));
  if (!list) return;
  const lim = +btn.dataset.tmRankMore;
  const open = btn.getAttribute("aria-expanded") !== "true";
  // 收起时上面的列表一下子短了一截：按钮留在手指下面原来的位置，不让它跑到屏幕外去
  const before = btn.getBoundingClientRect().top;
  [...list.children].forEach((li, i) => {
    if (i >= lim) li.hidden = !open;
  });
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = open ? "收起" : btn.dataset.label;
  if (!open) {
    const moved = btn.getBoundingClientRect().top - before;
    if (Math.abs(moved) > 1) window.scrollBy(0, moved);
  }
});

// ---------------------------------------------------------------- 空状态、错误、骨架

export function empty(text, { icon: ic = "chart-box-outline", title, action } = {}) {
  return html`<div class="tm-empty">
    <span class="tm-empty-icon">${icon(ic)}</span>
    ${title ? html`<div class="tm-empty-title">${title}</div>` : ""}
    ${text ? html`<div class="tm-empty-text">${text}</div>` : ""}
    ${action || ""}
  </div>`;
}

const retryFns = new Map();
let retrySeq = 0;

// 错误卡片。retry 是函数时显示「重试」按钮。401（登录过期）显示「重新登录」
export function error(err, retry) {
  const e = err || {};
  if (e.auth || e.status === 401) {
    return html`<div class="tm-empty tm-error is-auth" role="alert">
      <span class="tm-empty-icon">${icon("lock-outline")}</span>
      <div class="tm-empty-title">登录已过期</div>
      <div class="tm-empty-text">重新登录后就能继续查看。</div>
      <button type="button" class="tm-btn is-primary" data-tm-reload>重新登录</button>
    </div>`;
  }
  let id = null;
  if (typeof retry === "function") {
    id = "r" + ++retrySeq;
    retryFns.set(id, retry);
    // 只留最近的一些，旧的按钮早就不在页面上了
    if (retryFns.size > 40) retryFns.delete(retryFns.keys().next().value);
  }
  const title = e.network ? "连不上服务器" : "加载失败";
  const text = e.network ? "检查网络后再试一次。" : "数据没取到，可以再试一次。";
  const detail = e.network ? "" : e.message || String(err || "");
  return html`<div class="tm-empty tm-error" role="alert">
    <span class="tm-empty-icon">${icon(e.network ? "wifi-off" : "alert-circle-outline")}</span>
    <div class="tm-empty-title">${title}</div>
    <div class="tm-empty-text">${text}</div>
    ${detail ? html`<div class="tm-error-detail">${detail}</div>` : ""}
    ${id ? html`<button type="button" class="tm-btn is-soft" data-tm-retry="${id}">${icon("refresh")}<span>重试</span></button>` : ""}
  </div>`;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest && e.target.closest("[data-tm-retry], [data-tm-reload]");
  if (!t) return;
  e.preventDefault();
  if (t.hasAttribute("data-tm-reload")) {
    location.reload();
    return;
  }
  const fn = retryFns.get(t.dataset.tmRetry);
  if (fn) fn();
});

function skel(w, h, extra = "") {
  return raw(`<span class="tm-skel" style="width:${w};height:${h}px${extra}"></span>`);
}

// 加载中的占位：'stats' | 'list' | 'chart' | 'map' | 'kv'，也可以传数组按顺序拼
export function skeleton(kind = "list", { rows = 5, height } = {}) {
  if (Array.isArray(kind)) return html`<div class="tm-page" aria-busy="true">${kind.map((k) => skeleton(k, { rows, height }))}</div>`;
  let body;
  switch (kind) {
    case "stats":
      body = html`<div class="tm-stats tm-skel-stats">${[0, 1, 2, 3].map(
        () => html`<div class="tm-stat">${skel("55%", 11)}${skel("70%", 22)}</div>`
      )}</div>`;
      break;
    case "chart":
      body = card(
        html`<div class="tm-skel-chart" style="${height ? `height:${+height}px` : ""}">${[38, 62, 45, 80, 56, 70, 30, 66, 50, 74].map((h) => skel("auto", 0, `;height:${h}%`))}</div>`
      );
      break;
    case "map":
      body = card(skel("100%", height || 260, ";border-radius:0"), { pad: false, cls: "tm-list" });
      break;
    case "kv":
      body = card(
        html`<div class="tm-stack">${Array.from({ length: rows }, () => html`<div class="tm-between">${skel("30%", 12)}${skel("25%", 12)}</div>`)}</div>`
      );
      break;
    default:
      body = card(
        html`<div class="tm-list">${Array.from(
          { length: rows },
          () => html`<div class="tm-row has-icon">${skel("36px", 36, ";flex:none;border-radius:11px")}<div class="tm-row-main tm-stack" style="gap:8px">${skel("60%", 13)}${skel("40%", 11)}</div>${skel("56px", 13, ";flex:none")}</div>`
        )}</div>`,
        { pad: false }
      );
  }
  return html`<div aria-busy="true" aria-label="加载中">${body}</div>`;
}

// ---------------------------------------------------------------- 图表 / 地图的占位容器

// height：桌面高度（px），heightMobile：手机高度（默认同 height，都不给就是 260 / 220）
export function chartBox(id, { height, heightMobile, label } = {}) {
  const vars = [height ? `--tm-chart-h:${+height}px` : "", heightMobile ? `--tm-chart-h-m:${+heightMobile}px` : ""].filter(Boolean).join(";");
  return html`<div class="tm-chart" id="${id}"${vars ? raw(` style="${vars}"`) : ""} role="img"${label ? raw(` aria-label="${esc(label)}"`) : ""}></div>`;
}

// height：地图高度（px，默认 320）；maxVh：最高占视口的百分之几（默认 45，足迹这种以地图为主的页面可以放到 60）。
// maxVh 写在 CSS 变量 --tm-map-max 上（stats.css 按它限高），也写在 data-max-vh 上（页面自己写的容器只带 data-max-vh 时 map.js 补上变量）
export function mapBox(id, { height, maxVh } = {}) {
  const vh = Number.isFinite(+maxVh) && +maxVh > 0 ? Math.min(100, +maxVh) : null;
  const style = [height ? `--tm-map-h:${+height}px` : "", vh ? `--tm-map-max:${vh}vh` : ""].filter(Boolean).join(";");
  return html`<div class="tm-map-wrap"><div class="tm-map" id="${id}"${vh ? raw(` data-max-vh="${vh}"`) : ""}${style ? raw(` style="${style}"`) : ""}></div></div>`;
}

// ---------------------------------------------------------------- 列表页公共部件（行程、充电、待机掉电这类长列表）

// 按天分组：组头「今天 / 9月22日 周一」+ 右边当天合计，body 一般是 ui.card(ui.list(…), { pad: false })。
// 多个组放在 <div class="tm-days"> 里（组间 18px）。opts.key：这一天的标识（默认用 label），
// pager 追加下一页时，新一页第一组和已有最后一组是同一天，就把行并进已有的组，不会出现两个同样的组头
export function dayGroup(label, totals, body, { key, cls } = {}) {
  const k = key != null ? key : typeof label === "string" ? label : null;
  return html`<section class="tm-day${cls ? " " + cls : ""}"${k != null ? raw(` data-tm-append="day:${esc(k)}"`) : ""}>
    <div class="tm-day-head"><h3>${label}</h3>${present(totals) ? html`<span class="tm-day-sum tm-num">${totals}</span>` : ""}</div>
    ${body}
  </section>`;
}

// 分页的「再显示 50 次」：先画第一页，按钮追加下一页（不重画已有的行，展开的行、滚动位置都不动），
// 追加完把焦点移到新加的第一行（键盘、读屏不会掉回页面顶上）。
//   container：一个空元素（pager 接管它的内容）
//   total：总条数（不知道就给 null，这时一直显示按钮，直到某一页不满）
//   page：每次加多少（默认 50）
//   noun：「还有 180 次行程」「共 230 次行程，已全部显示」里的量词 + 名词；按钮「再显示 50 次」的量词取它的第一个字（unit 可改）
//   load(offset)：返回这一段的 Html，或 { html, count, done }。offset 0 是第一页，数据已经在手上时直接返回就行（不会闪）。
//     count 不给就当作取到了 min(page, 剩下的)；取到的比要的少、或 done: true，就当作到头了。
//     返回里顶层元素带 data-tm-append="键" 的（ui.dayGroup 自动带；卡片用 ui.card(…, { attrs: { "data-tm-append": "list" } })），
//     已有内容里有同样键的元素时，把新元素里的行（.tm-list 的行，或 tbody 的 tr）并进去，而不是再加一块
//   onDone(shown)：全部显示完时调用一次
// 返回 { ready（第一页画完的 Promise）, more()（手动加一页）, shown, done }
export function pager(container, { total = null, page = 50, noun = "条", unit, load, onDone } = {}) {
  const u = unit || String(noun).charAt(0) || "条";
  let shown = 0;
  let loading = false;
  let done = false;
  container.classList.add("tm-pager");
  render(container, raw('<div class="tm-pager-items"></div><div class="tm-pager-foot" aria-live="polite"></div>'));
  const itemsEl = container.firstElementChild;
  const footEl = container.lastElementChild;
  const left = () => (total == null ? null : Math.max(0, total - shown));

  const drawFoot = (err) => {
    if (err) {
      render(footEl, card(error(err, () => more(true))));
      return;
    }
    const l = left();
    if (!done && (l == null || l > 0)) {
      const btn = footEl.querySelector("[data-tm-pager-more]");
      // 加载中改原来的按钮（不重画）：重画会把键盘焦点弄丢；用 aria-disabled 而不是 disabled，焦点才留得住。
      // 第一页还没画出来时底下什么都不放
      if (loading) {
        if (btn) {
          btn.setAttribute("aria-disabled", "true");
          btn.lastElementChild.textContent = "正在加载…";
        }
        return;
      }
      const next = l == null ? page : Math.min(page, l);
      render(
        footEl,
        html`<div class="tm-pager-more">${button(`再显示 ${fmt.int(next)} ${u}`, { kind: "soft", attrs: { "data-tm-pager-more": "" } })}${
          l != null ? html`<span class="tm-note">还有 ${fmt.int(l)} ${noun}</span>` : ""
        }</div>`
      );
      return;
    }
    render(footEl, shown > page ? html`<p class="tm-note tm-pager-end">共 ${fmt.int(shown)} ${noun}，已全部显示</p>` : "");
  };

  async function more(focus) {
    if (loading || done) return;
    loading = true;
    drawFoot();
    const want = total == null ? page : Math.min(page, left());
    let res;
    try {
      res = await load(shown);
    } catch (err) {
      loading = false;
      if (err && err.name === "AbortError") return;
      drawFoot(err);
      return;
    }
    loading = false;
    const chunk = res && typeof res === "object" && !(res instanceof Html) && "html" in res ? res : { html: res };
    const n = Number.isFinite(chunk.count) ? chunk.count : want;
    const added = appendMerge(itemsEl, chunk.html);
    shown += n;
    if (chunk.done === true || (chunk.done !== false && (n < want || n <= 0 || (total != null && shown >= total)))) done = true;
    drawFoot();
    if (focus) focusFirst(added);
    if (done && onDone) onDone(shown);
  }

  footEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tm-pager-more]");
    if (btn && btn.getAttribute("aria-disabled") !== "true") more(true);
  });

  const ready = more(false);
  return {
    ready,
    more: () => more(true),
    get shown() {
      return shown;
    },
    get done() {
      return done;
    }
  };
}

// 追加一段 HTML；顶层元素带 data-tm-append 且已有同键元素时，把行并进去。返回新出现的元素（按文档顺序）
function appendMerge(box, content) {
  const tpl = document.createElement("template");
  tpl.innerHTML = part(content);
  const added = [];
  for (const n of [...tpl.content.children]) {
    const key = n.getAttribute("data-tm-append");
    const prev = key != null ? [...box.querySelectorAll(":scope > [data-tm-append]")].reverse().find((el) => el.getAttribute("data-tm-append") === key) : null;
    const into = prev && mergeBody(prev);
    const from = into && mergeBody(n);
    if (into && from && into.tagName === from.tagName) {
      const tail = [...into.children].find((c) => c.classList.contains("tm-list-more")) || null;
      for (const c of [...from.children]) {
        if (c.classList.contains("tm-list-more")) continue;
        into.insertBefore(c, tail);
        added.push(c);
      }
    } else {
      box.appendChild(n);
      added.push(n);
    }
  }
  hydrate(box);
  return added;
}

function mergeBody(el) {
  return el.querySelector("[data-tm-append-body]") || el.querySelector(".tm-list") || el.querySelector("tbody");
}

// 焦点移到新内容里第一个看得见、能聚焦的元素；都不能聚焦就聚焦第一个新元素本身（tabindex=-1，读屏从这里接着读）
function focusFirst(added) {
  const sel = "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";
  const visible = (el) => el.getClientRects().length > 0;
  for (const el of added) {
    const cand = el.matches(sel) ? [el] : [...el.querySelectorAll(sel)];
    const hit = cand.find(visible);
    if (hit) {
      hit.focus({ preventScroll: true });
      return;
    }
  }
  const first = added.find(visible);
  if (first) {
    if (!first.hasAttribute("tabindex")) first.tabIndex = -1;
    first.focus({ preventScroll: true });
  }
}

// 可展开的筛选条：收起时一行「[筛选 · 2 ⌄] 含「公司」 · ≥ 5 km  清除」，点按钮展开 body（放表单、分段选择、chip）。
//   summary：当前条件（文本 / Html，或数组 → 用「 · 」连起来，数组长度就是按钮上的个数）
//   active：有没有生效的条件（默认 summary 非空）。没有时按钮是普通样式，右边显示 hint
//   open：一开始是否展开（页面改筛选会重画整页，展开状态要页面自己记在模块变量里，靠 onToggle 更新）
//   onToggle(open)、onClear()：点按钮 / 点「清除」时调用（清除一般是 ctx.setQuery({ … : null })）
//   label（默认「筛选」）、hint（默认「按条件筛选」）、count（覆盖按钮上的个数）、autofocus（展开时聚焦第一个输入框，触屏上不聚焦免得弹键盘）
export function filterBar({ summary, active, body, open = false, onToggle, onClear, label = "筛选", hint = "按条件筛选", count, autofocus } = {}) {
  const id = uid("filter");
  if (onToggle || onClear) keep(filterFns, id, { onToggle, onClear });
  const parts = Array.isArray(summary) ? summary.filter(present) : present(summary) ? [summary] : [];
  const n = count != null ? count : Array.isArray(summary) ? parts.length : 0;
  const on = active != null ? !!active : parts.length > 0;
  return html`<div class="tm-filter${open ? " is-open" : ""}" data-tm-filter="${id}"${autofocus ? raw(" data-autofocus") : ""}>
    <div class="tm-filter-bar">
      <button type="button" class="tm-btn is-small${on ? " is-soft" : ""}" data-tm-filter-toggle aria-expanded="${open ? "true" : "false"}" aria-controls="${id}-panel">
        ${icon("filter-variant")}<span>${label}${n ? ` · ${n}` : ""}</span>${icon("chevron-down", { cls: "tm-filter-chev" })}
      </button>
      ${on
        ? html`<span class="tm-filter-sum tm-truncate">${parts.map((p, i) => html`${i ? " · " : ""}${p}`)}</span>
            <button type="button" class="tm-btn is-small is-text" data-tm-filter-clear>清除</button>`
        : html`<span class="tm-filter-sum tm-truncate tm-muted">${hint}</span>`}
    </div>
    <div class="tm-filter-panel tm-card is-pad" id="${id}-panel"${open ? "" : raw(" hidden")}>${body}</div>
  </div>`;
}

const filterFns = new Map();

// 展开 / 收起筛选条（open 不给就切换）；页面想用代码打开时用
export function setFilterOpen(box, open) {
  const bar = box && box.closest("[data-tm-filter]");
  if (!bar) return;
  const next = open == null ? !bar.classList.contains("is-open") : !!open;
  const btn = bar.querySelector("[data-tm-filter-toggle]");
  const panel = document.getElementById(btn.getAttribute("aria-controls"));
  bar.classList.toggle("is-open", next);
  btn.setAttribute("aria-expanded", next ? "true" : "false");
  if (panel) panel.hidden = !next;
  if (next && panel && bar.hasAttribute("data-autofocus") && !window.matchMedia("(pointer: coarse)").matches) {
    const input = panel.querySelector("input:not([type=hidden]), textarea");
    if (input) input.focus({ preventScroll: true });
  }
  const fns = filterFns.get(bar.dataset.tmFilter);
  if (fns && fns.onToggle) fns.onToggle(next);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest && e.target.closest("[data-tm-filter-toggle], [data-tm-filter-clear]");
  if (!t) return;
  const bar = t.closest("[data-tm-filter]");
  if (!bar) return;
  if (t.hasAttribute("data-tm-filter-toggle")) {
    setFilterOpen(bar);
    return;
  }
  const fns = filterFns.get(bar.dataset.tmFilter);
  if (fns && fns.onClear) fns.onClear();
});

// ---------------------------------------------------------------- 弹出面板
// 桌面上是贴着按钮的浮层，手机上是从底部弹出的面板。同一时间只开一个。

let openPop = null;

export function closeSheet() {
  if (openPop) openPop.close();
}

// anchor：触发按钮；content：Html 或元素；opts.title：手机面板顶部的标题；opts.wide：宽一点的面板
// 返回 { el, close }。点面板外、按 Esc、离开页面都会关闭
export function openSheet(anchor, content, { title, wide, onClose, label } = {}) {
  closeSheet();
  const backdrop = document.createElement("div");
  backdrop.className = "tm-backdrop";
  const pop = document.createElement("div");
  pop.className = "tm-pop" + (wide ? " is-wide" : "");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", label || title || "菜单");
  pop.tabIndex = -1;
  if (title) {
    const h = document.createElement("div");
    h.className = "tm-pop-title";
    h.textContent = title;
    pop.appendChild(h);
  }
  const box = document.createElement("div");
  if (content instanceof Element) box.appendChild(content);
  else render(box, content);
  pop.appendChild(box);
  document.body.append(backdrop, pop);

  const place = () => {
    if (window.matchMedia("(max-width: 768px)").matches || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let left = r.left + r.width / 2 > vw / 2 ? r.right - w : r.left;
    left = Math.max(10, Math.min(left, vw - w - 10));
    let top = r.bottom + 6;
    if (top + h > vh - 10 && r.top - h - 6 > 10) top = r.top - h - 6;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  };
  place();

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    }
  };
  // 只在宽度变了（转屏、拖窗口）时关。手机上地址栏收起 / 弹出键盘只改高度，也会触发 resize，
  // 那时关掉面板就成了「一滑就没了」
  const openWidth = window.innerWidth;
  const onResize = () => (window.innerWidth !== openWidth ? close(false) : place());
  let closed = false;
  function close(restoreFocus = true) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    pop.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    if (anchor) anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor && document.contains(anchor)) anchor.focus({ preventScroll: true });
    if (openPop === handle) openPop = null;
    if (onClose) onClose();
  }
  backdrop.addEventListener("click", () => close(false));
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  if (anchor) anchor.setAttribute("aria-expanded", "true");
  const first = pop.querySelector("button, a[href], input, select, [tabindex]:not([tabindex='-1'])");
  (first || pop).focus({ preventScroll: true });
  const handle = { el: pop, close };
  openPop = handle;
  return handle;
}

// 菜单：items = [{ label, icon, href, onClick, checked, external }] | { sep: true } | { heading: "…" }
export function menu(items) {
  const el = document.createElement("div");
  el.className = "tm-menu";
  el.setAttribute("role", "menu");
  for (const it of items.filter(Boolean)) {
    if (it.sep) {
      el.insertAdjacentHTML("beforeend", '<div class="tm-menu-sep" role="separator"></div>');
      continue;
    }
    if (it.heading) {
      const h = document.createElement("div");
      h.className = "tm-menu-label";
      h.textContent = it.heading;
      el.appendChild(h);
      continue;
    }
    const node = document.createElement(it.href ? "a" : "button");
    node.className = "tm-menu-item";
    node.setAttribute("role", "menuitem");
    if (it.href) {
      node.href = it.href;
      if (it.external) {
        node.target = "_blank";
        node.rel = "noopener";
      }
    } else node.type = "button";
    render(node, html`${it.icon ? icon(it.icon) : ""}<span>${it.label}</span>${it.checked ? icon("check", { cls: "tm-menu-check" }) : ""}`);
    node.addEventListener("click", (e) => {
      closeSheet();
      if (it.onClick) {
        e.preventDefault();
        it.onClick();
      }
    });
    el.appendChild(node);
  }
  return el;
}
