// 电量和里程（levels.js）、续航变化（projected-range.js）两页共用：取点、图例表。
// 图例表的样式在 pages/_series.css，两页的 CSS 开头 @import 它（路由等页面 CSS 加载完才画，@import 的也算在内）。
import { html } from "../core/ui.js";

// 查询结果 → [[时间, 值], …]，值为空的点去掉
export const series = (rows, key) => rows.filter((r) => r[key] != null).map((r) => [r.time, r[key]]);

// Grafana 图例的 mean / max / min / last：对图上每个点的值算，空值不算
export function calcs(points) {
  let n = 0;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  let last = null;
  for (const p of points) {
    const v = p[1];
    if (v == null || !Number.isFinite(v)) continue;
    n++;
    sum += v;
    if (v > max) max = v;
    if (v < min) min = v;
    last = v;
  }
  return n ? { mean: sum / n, max, min, last } : { mean: null, max: null, min: null, last: null };
}

export const STATS3 = [
  { key: "mean", label: "平均" },
  { key: "max", label: "最高" },
  { key: "min", label: "最低" }
];

// 「529 km」拆成数字 + 单位：列多的表（shortUnits）在 320 宽的手机上把「 km」藏掉，名字列才不会被挤成「满电…」
// （% 和 °C 本来就紧挨着数字）
function cell(text) {
  const m = /^(.*\d)( [A-Za-z]+)$/.exec(text);
  return m ? html`${m[1]}<span class="pg-series-unit">${m[2]}</span>` : text;
}

// 图下面的图例表（Grafana 的 table 图例）：色块、名字、各统计列。
// lines：[{ name, color（主题色名 c1…c6）, dashed, data: [[ms, v], …], fmt }]；cols：[{ key, label }]，key 是 calcs() 的字段。
// chart：图表容器的 id。toggle: true 时每行是按钮，点一下隐藏 / 显示那条线（配合 bindLegendToggle）。
// shortUnits: true 时 ≤374px 宽不写长度单位
export function legendTable(lines, { cols = STATS3, chart, toggle, shortUnits } = {}) {
  return html`<table class="pg-series-legend${toggle ? " is-toggle" : ""}${shortUnits ? " is-short-units" : ""}"${chart ? html` data-chart="${chart}"` : ""}>
    <thead><tr><th scope="col">系列</th>${cols.map((c) => html`<th scope="col">${c.label}</th>`)}</tr></thead>
    <tbody>${lines.map((l) => {
      const k = calcs(l.data);
      const name = html`<th scope="row"><i class="${l.dashed ? "is-dashed" : ""}" style="color:var(--tm-${l.color})"></i>${l.name}</th>`;
      const tds = cols.map((c) => html`<td>${cell(l.fmt(k[c.key]))}</td>`);
      return toggle
        ? html`<tr data-series="${l.name}" tabindex="0" role="button" aria-pressed="true" title="点一下隐藏 / 显示这条线">${name}${tds}</tr>`
        : html`<tr>${name}${tds}</tr>`;
    })}</tbody>
  </table>`;
}

// 图例表点一行（或回车、空格）：隐藏 / 显示对应的线。
// charts：Map(图表容器 id → { inst, hidden: Set })。hidden 由页面持有，换主题时 option 函数按它重设 legend.selected。
// 提示框用的是 chart.nearestTooltip，它读实例的图例状态，关掉的线提示框里也不显示
export function bindLegendToggle(root, charts) {
  const toggle = (tr) => {
    const c = charts.get(tr.closest("[data-chart]").dataset.chart);
    if (!c || !c.inst || c.inst.isDisposed()) return;
    const name = tr.dataset.series;
    const off = !c.hidden.has(name);
    if (off) c.hidden.add(name);
    else c.hidden.delete(name);
    // 联动的图（chart.connect）会把图例动作转给同组的其它图：同名的线（「按电量」）在别的图里也跟着藏起来，
    // 那张图的表却还显示着「开」。所以临时摘掉 group，只动这一张图（escapeConnect 对图例动作不起作用）
    const group = c.inst.group;
    c.inst.group = null;
    try {
      c.inst.dispatchAction({ type: off ? "legendUnSelect" : "legendSelect", name });
    } finally {
      c.inst.group = group;
    }
    tr.setAttribute("aria-pressed", off ? "false" : "true");
  };
  const row = (e) => e.target.closest(".pg-series-legend.is-toggle tr[data-series]");
  root.addEventListener("click", (e) => {
    const tr = row(e);
    if (tr) toggle(tr);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = row(e);
    if (!tr) return;
    e.preventDefault();
    toggle(tr);
  });
}
