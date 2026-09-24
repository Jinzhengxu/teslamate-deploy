/*
 * ECharts 封装：
 *   - 第一次用到时才插 <script> 加载 vendor/echarts-6.1.0/echarts.min.js（1.1MB，只下载一次，之后走浏览器长缓存）；
 *   - 颜色、字体从 CSS 变量读，和换肤同一套配色；亮暗切换时整张图按新颜色重画；
 *   - ResizeObserver 自适应；离开页面自动 dispose。
 *
 * 颜色写法：option 里任何字符串值写成 "@名字" 或 "@名字/透明度" 都会在绘制时换成当前主题的颜色，
 * 比如 "@green"、"@c1/0.15"、"@line"。这样亮暗切换时才能跟着变（写死 "#17a34a" 就不会变）。
 * 名字见下面 TOKENS。option 也可以传函数，每次（包括换主题）重新调用它生成 option。
 */
import * as fmt from "./format.js";
import { esc, onLeave } from "./ui.js";

const SRC = "/stats/vendor/echarts-6.1.0/echarts.min.js";
const DAY = 86400e3;

let loading = null;

export function load() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SRC;
      s.async = true;
      s.onload = () => resolve(window.echarts);
      s.onerror = () => {
        loading = null;
        s.remove();
        reject(new Error("图表组件加载失败，检查网络后重试"));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

// ---------------------------------------------------------------- 主题颜色

export const TOKENS = {
  accent: "--tm-accent",
  green: "--tm-green",
  amber: "--tm-amber",
  red: "--tm-red",
  violet: "--tm-violet",
  cyan: "--tm-cyan",
  c1: "--tm-c1",
  c2: "--tm-c2",
  c3: "--tm-c3",
  c4: "--tm-c4",
  c5: "--tm-c5",
  c6: "--tm-c6",
  text: "--tm-text",
  "text-2": "--tm-text-2",
  hint: "--tm-text-hint",
  "text-3": "--tm-text-3",
  line: "--tm-line",
  "line-strong": "--tm-line-strong",
  track: "--tm-track",
  surface: "--tm-surface",
  "surface-2": "--tm-surface-2",
  "surface-3": "--tm-surface-3",
  bg: "--tm-bg",
  "tooltip-bg": "--tm-tooltip-bg",
  "tooltip-fg": "--tm-tooltip-fg"
};

let tokenCache = null;

function readTokens() {
  if (tokenCache) return tokenCache;
  const cs = getComputedStyle(document.documentElement);
  tokenCache = {};
  for (const [k, v] of Object.entries(TOKENS)) tokenCache[k] = cs.getPropertyValue(v).trim();
  return tokenCache;
}

function withAlpha(c, a) {
  if (a == null || a === "") return c;
  a = Math.max(0, Math.min(1, +a));
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    const n = parseInt(h, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return `rgba(${p[0]},${p[1]},${p[2]},${(p.length > 3 ? p[3] : 1) * a})`;
  }
  return c;
}

// 当前主题下某个颜色：color("green")、color("c1", 0.2)。不认识的名字原样返回（可以直接传 #hex）
export function color(name, alpha) {
  const t = readTokens();
  const c = t[name] != null && t[name] !== "" ? t[name] : name;
  return withAlpha(c, alpha);
}

// 分类色（固定顺序）：c1 蓝、c2 橙、c3 紫、c4 绿、c5 青、c6 红
export function palette() {
  const t = readTokens();
  return [t.c1, t.c2, t.c3, t.c4, t.c5, t.c6];
}

const TOKEN_RE = /^@([a-z0-9-]+)(?:\/([\d.]+))?$/;

// 把 option 里的 "@名字" 换成颜色。data 数组只在元素是对象时才往里找（大数组不值得遍历）
function resolve(v, key) {
  if (typeof v === "string") {
    const m = TOKEN_RE.exec(v);
    return m && TOKENS[m[1]] ? color(m[1], m[2]) : v;
  }
  if (Array.isArray(v)) {
    if ((key === "data" || key === "source") && v.length && (typeof v[0] !== "object" || v[0] === null || Array.isArray(v[0]))) return v;
    return v.map((x) => resolve(x));
  }
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = resolve(v[k], k);
    return o;
  }
  return v;
}

// 系列颜色参数：主题色名字 → "@名字"，其它当 CSS 颜色
function tok(c) {
  if (c == null) return undefined;
  return typeof c === "string" && TOKENS[c] ? "@" + c : c;
}

// 提示框等 JS 里要用的实际颜色：主题色名字、"@名字/透明度" 或 CSS 颜色
function paintColor(c) {
  if (c == null) return undefined;
  if (typeof c !== "string") return c;
  return c[0] === "@" ? resolve(c) : color(c);
}

// ---------------------------------------------------------------- 默认样式

const isPlain = (v) => v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

// 深合并：b 覆盖 a（数组整体替换）
function merge(a, b) {
  if (b === undefined) return a;
  if (!isPlain(a) || !isPlain(b)) return b;
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = merge(a[k], b[k]);
  return o;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function small() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function font() {
  return getComputedStyle(document.body).fontFamily;
}

let measurer = null;

// 文字宽度（像素），给坐标轴两端留白、nice 刻度估算标签宽度用
function textWidth(s, fs) {
  if (!measurer) measurer = document.createElement("canvas").getContext("2d");
  if (!measurer) return String(s).length * fs * 0.62;
  measurer.font = `${fs}px ${font()}`;
  return measurer.measureText(String(s)).width;
}

function decimalsOf(v) {
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(2, s.length - i - 1);
}

// 坐标轴数字：大数压缩成「万」，其余按刻度本身的小数位
export function axisNumber(v) {
  if (!Number.isFinite(v)) return "";
  return Math.abs(v) >= 1e5 ? fmt.compact(v) : fmt.num(v, decimalsOf(+v.toFixed(2)));
}

const TIME_LABELS = {
  year: "{yyyy}年",
  month: "{M}月",
  day: "{M}月{d}日",
  hour: "{HH}:{mm}",
  minute: "{HH}:{mm}",
  second: "{HH}:{mm}:{ss}",
  millisecond: "{HH}:{mm}:{ss}",
  none: "{M}月{d}日 {HH}:{mm}"
};

// 时间轴刻度格式按轴的跨度选：
//   - 不到两个月：月初那一刻（ECharts 算作「月」级刻度）也写「5月1日」，只写「5月」像是写错了；
//   - 跨年：按天 / 周的刻度带年份写成「2025/12/29」，不然 12月29日 和 1月5日 哪年的分不清。
//     按月的刻度照旧写「12月」，1 月 1 日那个刻度本来就写「2026年」。
const crossesYear = ([lo, hi]) => new Date(lo).getFullYear() !== new Date(Math.max(lo, hi - 1)).getFullYear();

function timeLabels(ext) {
  if (!ext) return TIME_LABELS;
  const [lo, hi] = ext;
  const crossYear = crossesYear(ext);
  const short = hi - lo < 62 * DAY;
  const md = crossYear ? "{yyyy}/{M}/{d}" : "{M}月{d}日";
  return {
    ...TIME_LABELS,
    year: short ? md : TIME_LABELS.year,
    month: short ? md : TIME_LABELS.month,
    day: md,
    none: `${md} {HH}:{mm}`
  };
}

// 刻度模板套上一个「最宽」的日期，估算标签最宽有多宽
function sampleLabel(tpl) {
  return String(tpl).replace(/\{(yyyy|MM|M|dd|d|HH|mm|ss)\}/g, (_, k) => ({ yyyy: "2025", MM: "12", M: "12", dd: "28", d: "28", HH: "23", mm: "58", ss: "58" })[k]);
}

function axisDefaults(axis, isX, t, fs, ext) {
  const type = axis.type || (isX ? "category" : "value");
  const d = {
    // onZero: false —— 数值型 x 轴有负数时，y 轴（和它的单位）别跑到 x=0 的位置去
    axisLine: { show: isX, onZero: false, lineStyle: { color: t["line-strong"] } },
    axisTick: { show: false },
    axisLabel: { color: t.hint, fontSize: fs, hideOverlap: true, margin: 8 },
    splitLine: { show: !isX, lineStyle: { color: t.line, width: 1, type: "solid" } },
    nameTextStyle: { color: t.hint, fontSize: fs },
    axisPointer: { label: { backgroundColor: t["tooltip-bg"], color: t["tooltip-fg"], fontSize: fs } }
  };
  if (type === "value" || type === "log") d.axisLabel.formatter = axisNumber;
  if (type === "time") d.axisLabel.formatter = timeLabels(ext);
  if (type === "category") d.axisTick = { show: false, alignWithLabel: true };
  return d;
}

// 某根坐标轴上数据的范围：x 轴看 encode.x（默认第 0 列），y 轴看 encode.y（默认第 1 列）。
// 只认 [[x, y], …] 和 { value: [...] } 两种写法；纯数值数组（分类轴）不算
function dataExtent(series, isX, index) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    if (!s || !Array.isArray(s.data) || s.type === "pie") continue;
    if ((s[isX ? "xAxisIndex" : "yAxisIndex"] || 0) !== index) continue;
    const enc = s.encode && s.encode[isX ? "x" : "y"];
    const dims = enc != null ? asArray(enc) : [isX ? 0 : 1];
    for (const d of s.data) {
      const v = Array.isArray(d) ? d : d && Array.isArray(d.value) ? d.value : null;
      if (!v) continue;
      for (const k of dims) {
        const x = v[k];
        if (x == null || x === "") continue;
        const n = +x;
        if (!Number.isFinite(n)) continue;
        if (n < lo) lo = n;
        if (n > hi) hi = n;
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

const numOf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : v instanceof Date ? v.getTime() : null);

// 坐标轴的实际范围：写了数字 min / max 的用它，没写（或写的是 "dataMin"、函数）的按数据算
function axisExtent(a, series, isX, index) {
  let lo = numOf(a.min);
  let hi = numOf(a.max);
  if (lo == null || hi == null) {
    const e = dataExtent(series, isX, index);
    if (e) {
      if (lo == null) lo = e[0];
      if (hi == null) hi = e[1];
    }
  }
  return lo != null && hi != null && hi >= lo ? [lo, hi] : null;
}

const AXIS_TYPES = new Set(["line", "bar"]);

function seriesDefaults(s, t) {
  switch (s.type) {
    case "line":
      return {
        showSymbol: false,
        symbol: "circle",
        symbolSize: 8,
        lineStyle: { width: 2, cap: "round", join: "round" },
        itemStyle: { borderColor: t.surface, borderWidth: 2 },
        emphasis: { focus: "none", scale: false, lineStyle: { width: 2 } },
        connectNulls: false
      };
    case "bar":
      return {
        barMaxWidth: 24,
        itemStyle: s.stack ? { borderColor: t.surface, borderWidth: 1, borderRadius: 0 } : { borderRadius: [4, 4, 0, 0] },
        emphasis: { focus: "none" }
      };
    case "pie":
      return {
        radius: ["52%", "78%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
        label: { color: t["text-2"], fontSize: small() ? 11 : 12 },
        labelLine: { lineStyle: { color: t["line-strong"] }, length: 8, length2: 8 },
        emphasis: { scaleSize: 4 }
      };
    case "scatter":
      return { symbolSize: 8, itemStyle: { borderColor: t.surface, borderWidth: 1, opacity: 0.85 }, emphasis: { scale: 1.3 } };
    case "heatmap":
      return { itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } } };
    default:
      return {};
  }
}

// ---------------------------------------------------------------- nice 刻度（数值轴两端贴着数据、刻度落在整数上）

const NICE = [1, 2, 2.5, 5];

function isNiceStep(step) {
  if (!(step > 0) || !Number.isFinite(step)) return false;
  const p = Math.pow(10, Math.floor(Math.log10(step)));
  const m = step / p;
  return NICE.some((k) => Math.abs(m - k) < 1e-9) || Math.abs(m - 10) < 1e-9;
}

const isMultiple = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-9;

// [lo, hi] 里的整刻度：步长从 1 / 2 / 2.5 / 5 × 10ⁿ 里挑最小的、让标签排得下的那个。
// label(v) 给出刻度文字，px 是轴的像素长度；每个标签按「字宽 + 16px 间隔」算
export function niceTicks(lo, hi, px, label = axisNumber, fs = 11) {
  if (!(hi > lo)) return Number.isFinite(lo) ? [lo] : [];
  const span = hi - lo;
  let p = Math.pow(10, Math.floor(Math.log10(span / 12)));
  // 步长越大刻度越少；大到范围里一个整刻度都没有时，退回上一个（排不下也比没有刻度好）
  let fallback = [];
  for (let guard = 0; guard < 40; guard++) {
    for (const k of NICE) {
      const step = k * p;
      const first = Math.ceil(lo / step - 1e-9);
      const last = Math.floor(hi / step + 1e-9);
      const n = last - first + 1;
      if (n > 12) continue;
      if (n < 1) return fallback;
      const ticks = [];
      for (let i = first; i <= last; i++) ticks.push(+(i * step).toPrecision(12));
      const w = Math.max(...ticks.map((v) => textWidth(label(v), fs))) + 16;
      if (n * w <= px) return ticks;
      fallback = ticks;
    }
    p *= 10;
  }
  return fallback;
}

// ---------------------------------------------------------------- 提示框

function markerColor(p) {
  const c = p.color;
  if (typeof c === "string") return c;
  if (c && c.colorStops && c.colorStops.length) return c.colorStops[0].color;
  return "currentColor";
}

// 自己写 formatter 时也可以用它拼出同样样式的提示框：tipHtml("9月24日", [{ color, name, value }])
export function tipHtml(title, rows) {
  const r = rows
    .filter(Boolean)
    .map(
      (x) =>
        `<div class="tm-tip-row">${x.color ? `<i style="background:${esc(x.color)}"></i>` : ""}<span>${esc(x.name ?? "")}</span><b>${esc(x.value ?? "")}</b></div>`
    )
    .join("");
  return `<div class="tm-tip">${title != null && title !== "" ? `<div class="tm-tip-title">${esc(title)}</div>` : ""}${r}</div>`;
}

function isMidnight(ms) {
  const d = new Date(ms);
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
}

// 时间轴上的点：整天的数据显示「9月24日 周四」，否则「9月24日 14:05」
export function timeTitle(ms) {
  return isMidnight(ms) ? `${fmt.dateAuto(ms)} ${fmt.weekday(ms)}` : fmt.dateTime(ms);
}

function pickValue(p) {
  const v = p.value;
  if (!Array.isArray(v)) return v;
  const enc = p.encode || {};
  const dim = (enc.y && enc.y[0]) ?? (enc.value && enc.value[0]) ?? 1;
  return v[dim];
}

function makeTipFormatter(fmts) {
  return (params) => {
    const list = Array.isArray(params) ? params : [params];
    if (!list.length) return "";
    const p0 = list[0];
    const vf = (p) => fmts[p.seriesIndex] || ((v) => (typeof v === "number" ? axisNumber(v) : v));
    if (Array.isArray(params)) {
      let title = p0.axisValueLabel;
      if (p0.axisType && /time$/.test(p0.axisType) && Number.isFinite(+p0.axisValue)) title = timeTitle(+p0.axisValue);
      return tipHtml(
        title,
        list.map((p) => {
          const v = pickValue(p);
          return v == null || v === "-" || Number.isNaN(v) ? null : { color: markerColor(p), name: p.seriesName, value: vf(p)(v, p) };
        })
      );
    }
    const p = p0;
    if (p.seriesType === "pie") {
      return tipHtml(p.seriesName, [{ color: markerColor(p), name: p.name, value: `${vf(p)(p.value, p)}（${fmt.num(p.percent, p.percent < 10 ? 1 : 0)}%）` }]);
    }
    const v = pickValue(p);
    return tipHtml(p.name || p.seriesName, [{ color: markerColor(p), name: p.name ? p.seriesName : "", value: vf(p)(v, p) }]);
  };
}

// ---------------------------------------------------------------- 组装

// 图例折行时项之间的间隔：ECharts 的 itemGap 横竖两个方向共用，比一行时的 14 紧一点，多一行只多占 23px 左右
const LEGEND_WRAP_GAP = 12;

// 图例在宽 w 的图上排成几行。一行（按原来的间隔）摆得下是 1；否则按折行的间隔从左往右排，排满一行换下一行。
// 每项宽 = 色块 + 5px + 文字（ECharts 就是这么排的），图例四边自带 5px 内边距
function legendRows(names, lg, fs, w) {
  const widths = names.map((n) => lg.itemWidth + 5 + textWidth(n, fs));
  const room = w - 10;
  if (widths.reduce((s, x) => s + x, 0) + lg.itemGap * (widths.length - 1) <= room) return 1;
  let rows = 1;
  let x = 0;
  for (const iw of widths) {
    if (x > 0 && x + iw > room) {
      rows++;
      x = 0;
    }
    x += iw + LEGEND_WRAP_GAP;
  }
  return rows;
}

// 标签是否画出来（show: false 或 axisLabel.show: false 的不算）
const labelsShown = (a) => a && a.show !== false && !(a.axisLabel && a.axisLabel.show === false);

// inst：已有实例时传进来（nice 刻度要知道图有多宽，nearestTooltip 要知道图例关掉了哪些线）
function build(src, extra = {}, inst = null) {
  const raw = typeof src === "function" ? src() : src;
  const o = resolve(raw || {});
  const t = readTokens();
  const fs = small() ? 11 : 12;
  const series = asArray(o.series).map((s) => merge(seriesDefaults(s, t), s));
  const named = series.filter((s) => s.type !== "pie" && s.name && s.showInLegend !== false);
  const axisTrigger = series.some((s) => AXIS_TYPES.has(s.type));
  // 页面写了 legend.show 就听页面的（图例画在图外时写 show: false，顶上就不留那 34px）；没写才按系列数判断
  const legendOpt = Array.isArray(o.legend) ? o.legend[0] : o.legend;
  const showLegend = legendOpt && typeof legendOpt.show === "boolean" ? legendOpt.show : named.length >= 2;
  const fmts = series.map((s) => (s.tooltip && s.tooltip.valueFormatter) || null);

  const base = {
    color: palette(),
    backgroundColor: "transparent",
    animationDuration: 300,
    animationDurationUpdate: 200,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    textStyle: { fontFamily: font(), fontSize: fs, color: t["text-2"] },
    legend: {
      show: showLegend,
      type: "scroll",
      top: 0,
      left: 0,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 14,
      textStyle: { color: t["text-2"], fontSize: fs },
      inactiveColor: t["text-3"],
      pageIconColor: t["text-2"],
      pageTextStyle: { color: t.hint }
    },
    tooltip: {
      trigger: axisTrigger ? "axis" : "item",
      confine: true,
      backgroundColor: t["tooltip-bg"],
      borderWidth: 0,
      padding: [8, 11],
      textStyle: { color: t["tooltip-fg"], fontSize: 12.5, fontFamily: font() },
      extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.22);",
      axisPointer: { type: "line", lineStyle: { color: t["line-strong"], width: 1 }, shadowStyle: { color: withAlpha(t["text-3"], 0.12) } },
      formatter: makeTipFormatter(fmts)
    },
    visualMap: undefined
  };

  const out = merge(base, { ...o, series: undefined });
  out.series = series;
  // 热力图的色条（visualMap）默认放在底部，给它留出位置
  const vmBottom = o.visualMap && !Array.isArray(o.visualMap) && o.visualMap.show !== false && !o.visualMap.orient;
  const gridBase = { left: 2, right: 8, top: showLegend ? 34 : 12, bottom: vmBottom ? 36 : 2, outerBoundsMode: "same", outerBoundsContain: "all" };
  const hasCartesian = o.xAxis != null || o.yAxis != null;
  if (hasCartesian) {
    let edge = 0;
    const niceAxes = [];
    const shortTime = [];
    for (const [k, isX] of [["xAxis", true], ["yAxis", false]]) {
      if (o[k] == null) continue;
      const axes = asArray(o[k]).map((a, i) => {
        const type = a.type || (isX ? "category" : "value");
        const ext = type === "time" || a.__tmNice ? axisExtent(a, series, isX, i) : null;
        const r = merge(axisDefaults(a, isX, t, fs, ext), a);
        if (a.__tmNice) niceAxes.push({ axis: r, isX, ext });
        // 跨年、半年以上的时间轴在窄图上（手机、桌面窄栏）默认的刻度太密：ECharts 会把「2026年」这种年份标签
        // 当成和月份挤在一起的那个藏掉，只剩「7月 11月 3月 7月」，看不出是哪年。刻度放稀一点年份就留得住
        if (type === "time" && ext && a.splitNumber == null && inst && ext[1] - ext[0] > 180 * DAY && crossesYear(ext)) {
          if ((isX ? inst.getWidth() : inst.getHeight()) < 480) r.splitNumber = 3;
        }
        // 一天多到八天的时间轴：ECharts 按小时出刻度（手机上 6 小时一格），0 点那一格的日期「9月24日」夹在「18:00」「06:00」中间，
        // 被当成重叠的字藏掉，只剩「06:00 12:00 18:00 06:00…」，看不出是哪天。刻度按图宽放稀（每格约 85px，下面算），日期就留得住。
        // 一天以内的（过夜的充电）不动：放稀了只剩「9月19日 01:00」两个刻度，还不如原来一刻钟一格
        if (isX && type === "time" && ext && a.splitNumber == null && inst && ext[1] - ext[0] > DAY && ext[1] - ext[0] <= 8 * DAY) shortTime.push(r);
        // 时间轴的刻度文字居中压在刻度上，靠边的那个离画布边不到半个字宽时会被切掉（「9月22E」）。
        // outerBoundsContain 按估算的刻度留白，实际刻度和估算的不一样时就漏了。所以按最宽的标签算出半个字宽，
        // 下面给「没有纵轴文字」的一侧留出来（有纵轴文字的一侧本来就有这么宽）
        if (isX && type === "time" && labelsShown(r)) {
          const f = r.axisLabel && r.axisLabel.formatter;
          const levels = ext && ext[1] - ext[0] > 400 * DAY ? ["year", "month"] : ["year", "month", "day"];
          const samples = isPlain(f) ? levels.map((l) => sampleLabel(f[l] || TIME_LABELS[l])) : ["12月28日"];
          const lfs = (r.axisLabel && r.axisLabel.fontSize) || fs;
          edge = Math.max(edge, Math.ceil(Math.max(...samples.map((s) => textWidth(s, lfs))) / 2) + 2);
        }
        return r;
      });
      out[k] = Array.isArray(o[k]) ? axes : axes[0];
    }
    // 第一根纵轴默认在左，同一个 grid 的第二根默认在右
    const ys = asArray(out.yAxis);
    const side = (a, i) => a.position || (i === 0 ? "left" : "right");
    const labelled = (where) => ys.some((a, i) => labelsShown(a) && side(a, i) === where);
    if (edge) {
      if (!labelled("left")) gridBase.left = Math.max(gridBase.left, edge);
      if (!labelled("right")) gridBase.right = Math.max(gridBase.right, edge);
    }
    // 横轴的像素长度：图宽扣掉两边的纵轴文字（大约 40px）或留白。390 宽两天是「9月23日 12:00 9月24日 12:00」，320 宽是「9月23日 9月24日」
    for (const r of shortTime) {
      const px = inst.getWidth() - (labelled("left") ? 40 : gridBase.left) - (labelled("right") ? 40 : gridBase.right);
      r.splitNumber = Math.max(2, Math.min(6, Math.round(px / 85)));
    }
    for (const n of niceAxes) applyNice(n, inst, fs);
    out.grid = Array.isArray(o.grid) ? o.grid.map((g) => merge(gridBase, g)) : merge(gridBase, o.grid);
    // 图例一行放不下（手机上四五条线）时折成两三行、图往下让出多的行，不用翻页的图例（「‹ 1/2 ›」要点了才看得到后面的，
    // 也点不到后面那几条的开关）。行数按图宽算，宽度变了跟着变（create 里的 ResizeObserver）。
    // 页面自己写了 legend.type 或 grid.top 的听页面的；三行都放不下的还是翻页
    if (inst && showLegend && isPlain(out.legend) && isPlain(out.grid) && !(legendOpt && legendOpt.type) && out.legend.orient !== "vertical" && !(isPlain(o.grid) && o.grid.top != null)) {
      const names = legendOpt && Array.isArray(legendOpt.data) ? legendOpt.data.map((d) => (isPlain(d) ? d.name : d)) : named.map((s) => s.name);
      const rows = legendRows([...new Set(names)], out.legend, fs, inst.getWidth());
      if (rows > 1 && rows <= 3) {
        out.legend = { ...out.legend, type: "plain", itemGap: LEGEND_WRAP_GAP };
        out.grid = { ...out.grid, top: out.grid.top + (rows - 1) * (Math.max(out.legend.itemHeight, fs) + LEGEND_WRAP_GAP) };
      }
    }
  }
  if (o.visualMap) {
    const vmBase = {
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 10,
      itemHeight: 120,
      calculable: false,
      textStyle: { color: t.hint, fontSize: fs },
      inRange: { color: [t["surface-3"], t.c1] }
    };
    out.visualMap = Array.isArray(o.visualMap) ? o.visualMap.map((v) => merge(vmBase, v)) : merge(vmBase, o.visualMap);
  } else delete out.visualMap;
  // 缩放没写 filterMode 时：全是柱子就 filter（纵轴按窗口里的柱子定刻度，窗口外一根特别高的不会把其它柱子压扁），
  // 有折线的用 none（filter 会把窗口边上的线段连同窗口外那一点一起去掉，线在边上断开）
  if (out.dataZoom) {
    const allBars = series.length > 0 && series.every((s) => s.type === "bar");
    out.dataZoom = asArray(out.dataZoom).map((z) => (z && z.filterMode == null ? { ...z, filterMode: allBars ? "filter" : "none" } : z));
  }
  // nearestTooltip 要知道图例关掉了哪些线：formatter 里拿不到实例，这里包一层把实例的图例状态递进去
  const tf = out.tooltip && out.tooltip.formatter;
  if (inst && typeof tf === "function" && tf.__tmNearest) out.tooltip = { ...out.tooltip, formatter: (p) => tf(p, inst.__tmSelected) };
  return merge(out, extra);
}

// 调试 / 单元测试用：看合并了默认值之后交给 ECharts 的 option
export function _build(option, inst) {
  return build(option, {}, inst || null);
}

// nice 轴：两端贴着数据，刻度用 customValues 直接给出（刻度数按轴的像素长度和标签宽度定）
function applyNice({ axis, isX, ext }, inst, fs) {
  const cfg = axis.__tmNice;
  delete axis.__tmNice;
  if (!ext) return;
  let [lo, hi] = ext;
  if (hi === lo) {
    const d = Math.abs(lo) > 1 ? Math.abs(lo) * 0.05 : 1;
    lo -= d;
    hi += d;
  }
  const pad = (hi - lo) * (cfg.pad || 0);
  lo -= pad;
  hi += pad;
  // 轴长：扣掉纵轴文字和留白的大概宽度。没有实例（第一次画之前）时按手机宽度估
  const full = inst ? (isX ? inst.getWidth() : inst.getHeight()) : isX ? 330 : 200;
  const px = Math.max(60, full - (isX ? 48 : 40));
  const f = axis.axisLabel && typeof axis.axisLabel.formatter === "function" ? axis.axisLabel.formatter : axisNumber;
  const lfs = (axis.axisLabel && axis.axisLabel.fontSize) || fs;
  const ticks = niceTicks(lo, hi, px, (v) => f(v, 0), lfs);
  axis.min = lo;
  axis.max = hi;
  delete axis.interval;
  axis.axisLabel = { ...axis.axisLabel, customValues: ticks };
  axis.axisTick = { ...axis.axisTick, customValues: ticks };
}

// ---------------------------------------------------------------- 实例

const live = new Set();

// 按 inst.__tmOption 重新组装并画出来（第一次、换主题、update 都走这里）。
// notMerge 会把图例的开关状态重置成 option 里写的，nearestTooltip 用的图例状态跟着重置
function draw(inst, opts) {
  const o = build(inst.__tmOption, {}, inst);
  const lg = Array.isArray(o.legend) ? o.legend[0] : o.legend;
  inst.__tmSelected = lg && lg.selected ? { ...lg.selected } : null;
  inst.__tmLayoutKey = layoutKey(o);
  inst.setOption(o, opts);
}

// 随图宽变化的设置（nice 刻度、时间轴的 splitNumber、图例折成几行）的签名：宽度变了、这些跟着变时才需要重设
function layoutKey(o) {
  const ks = [];
  for (const k of ["xAxis", "yAxis"]) {
    for (const a of asArray(o[k])) {
      if (!a) continue;
      if (a.axisLabel && a.axisLabel.customValues) ks.push(a.axisLabel.customValues.join(","));
      if (a.type === "time") ks.push("t" + (a.splitNumber ?? ""));
    }
  }
  const lg = asArray(o.legend)[0];
  const g = asArray(o.grid)[0];
  if (lg && lg.show && g) ks.push(`l${lg.type}:${g.top}`);
  return ks.join("|");
}

window.addEventListener("tm-themechange", () => {
  tokenCache = null;
  for (const inst of live) {
    if (inst.isDisposed()) {
      live.delete(inst);
      continue;
    }
    draw(inst, { notMerge: true });
  }
});

const LEGEND_EVENTS = ["legendselectchanged", "legendselected", "legendunselected", "legendselectall", "legendinverseselect"];

// el：元素或 id；option：ECharts option（或返回 option 的函数），和默认样式深合并。
// 返回 ECharts 实例；页面已经离开（元素不在文档里了）时返回 null。
export async function create(el, option, { onClick, renderer = "canvas" } = {}) {
  const node = typeof el === "string" ? document.getElementById(el) : el;
  if (!node) throw new Error("图表容器不存在：" + el);
  const echarts = await load();
  if (!node.isConnected) return null;
  const old = echarts.getInstanceByDom(node);
  if (old) old.dispose();
  const inst = echarts.init(node, null, { renderer, locale: "ZH" });
  inst.__tmOption = option;
  draw(inst);
  if (onClick) inst.on("click", (p) => onClick(p, inst));
  for (const ev of LEGEND_EVENTS) inst.on(ev, (e) => (inst.__tmSelected = e && e.selected ? { ...e.selected } : null));
  live.add(inst);

  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (inst.isDisposed()) return;
      inst.resize({ animation: { duration: 0 } });
      // nice 刻度、时间轴刻度疏密、图例行数按宽度定：宽度变了、跟着变时只换坐标轴、grid 和图例（不用 notMerge，缩放窗口保留）
      if (inst.__tmLayoutKey) {
        const o = build(inst.__tmOption, {}, inst);
        const key = layoutKey(o);
        if (key !== inst.__tmLayoutKey) {
          inst.__tmLayoutKey = key;
          // replaceMerge：这几样整个换成新的（merge 方式删不掉上一次加的 splitNumber，图例从翻页换成折行也得重建），
          // 其它组件和状态不动；图例重建时把用户点掉的线带过去
          const next = {};
          for (const k of ["xAxis", "yAxis", "grid", "legend"]) if (o[k] !== undefined) next[k] = o[k];
          if (inst.__tmSelected && isPlain(next.legend)) next.legend = { ...next.legend, selected: inst.__tmSelected };
          inst.setOption(next, { replaceMerge: Object.keys(next) });
        }
      }
    });
  });
  ro.observe(node);
  onLeave(() => {
    ro.disconnect();
    cancelAnimationFrame(frame);
    live.delete(inst);
    if (!inst.isDisposed()) inst.dispose();
  });
  return inst;
}

// 换掉图表的 option（换主题时也按新的这份重画）
export function update(inst, option) {
  if (!inst || inst.isDisposed()) return;
  inst.__tmOption = option;
  draw(inst, { notMerge: true });
}

let groupSeq = 0;

// 几张图联动（提示框、缩放一起动）。insts 里的 null（页面已离开时 create 返回的）会跳过；
// 离开页面自动断开。返回组名（少于两张图时返回 null，不用联动）
export function connect(insts, group) {
  const list = asArray(insts).filter((i) => i && !i.isDisposed());
  if (list.length < 2 || !window.echarts) return null;
  const id = group || `tm-link-${++groupSeq}`;
  for (const i of list) i.group = id;
  window.echarts.connect(id);
  onLeave(() => window.echarts && window.echarts.disconnect(id));
  return id;
}

// ---------------------------------------------------------------- 助手（返回 option 片段，可以随意再改）

export function timeAxis(extra = {}) {
  return merge({ type: "time", splitLine: { show: false } }, extra);
}

// unit 显示在坐标轴顶端；fmt：刻度格式化函数。
// nice: true —— 两端贴着数据（或给定的 min / max），刻度按图宽挑 1 / 2 / 2.5 / 5 × 10ⁿ 的整数（里程这类数值型 x 轴用）；
//   pad：两端各留出范围的几分之几（默认 0）
// integer: true —— 值本来就是整数（电量 %）：刻度只落在整数上，65–75% 不会按 2.5 一格出现 67.5%
export function valueAxis({ unit, min, max, fmt: f, name, position, nice, pad, integer, ...rest } = {}) {
  const a = { type: "value", min, max, splitNumber: 4 };
  if (integer) a.minInterval = 1;
  // 上下限都定了（比如 0–100%）时自己定刻度间隔，免得出现 0/30/60/90/100 这种挤在一起的最后一格。
  // 依次试 4、5、3、6、2 等分，只接受 1 / 2 / 2.5 / 5 × 10ⁿ 的步长、而且 min 落在刻度上（不然会出现 22.5、7.5 这种刻度）。
  // 都不行时，4 等分是整数、min 也在刻度上的照旧用（状态页 0–24 小时按 6 小时一格）；再不行交给 ECharts
  if (!nice && typeof min === "number" && typeof max === "number" && max > min) {
    const ok = (step) => isMultiple(min, step) && (!integer || Number.isInteger(step));
    const step = [4, 5, 3, 6, 2].map((n) => (max - min) / n).find((st) => isNiceStep(st) && ok(st));
    const whole = (max - min) / 4;
    if (step) a.interval = step;
    else if (Number.isInteger(whole) && ok(whole)) a.interval = whole;
  }
  if (nice) a.__tmNice = { pad: +pad || 0 };
  if (unit || name) {
    a.name = name || unit;
    a.nameLocation = "end";
    a.nameGap = 10;
    a.nameTextStyle = { align: position === "right" ? "right" : "left", padding: [0, 0, 0, 0] };
  }
  if (position) a.position = position;
  if (f) a.axisLabel = { formatter: f };
  return merge(a, rest);
}

export function categoryAxis(data, extra = {}) {
  return merge({ type: "category", data }, extra);
}

// 折线。data：[[时间毫秒, 值], …] 或值数组；color：主题色名（"accent" "green" "c2"…）或 CSS 颜色
// opts.fmt：提示框里这条线的数值格式化，如 (v) => fmt.kwh(v)
// opts.sampling：点特别多时可以传 "lttb" 降采样。默认不降：降采样后指针高亮的点和提示框的值取自采样后的数据，
//   和真实值对不上（电量图上高亮在 45%，那一刻实际是 80%）；canvas 直接画几万个点也不慢
export function line(name, data, { color: c, area, smooth, step, yAxisIndex, width, fmt: f, symbol, z, dashed, sampling } = {}) {
  const col = tok(c);
  const s = { type: "line", name, data, smooth: smooth ? 0.3 : false, step: step || false, yAxisIndex, z };
  if (col) {
    s.itemStyle = { color: col };
    s.lineStyle = { color: col };
  }
  if (width || dashed) s.lineStyle = { ...(s.lineStyle || {}), width: width || 2, type: dashed ? "dashed" : "solid" };
  if (symbol) s.showSymbol = true;
  if (area) {
    const base = typeof c === "string" && TOKENS[c] ? c : null;
    s.areaStyle = base
      ? {
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: `@${base}/0.2` }, { offset: 1, color: `@${base}/0.02` }]
          }
        }
      : { opacity: 0.12 };
  }
  if (sampling) s.sampling = sampling;
  if (f) s.tooltip = { valueFormatter: f };
  return s;
}

// 柱子。stack：堆叠组名；horizontal：横向（y 轴是分类）
export function bars(name, data, { color: c, stack, yAxisIndex, horizontal, fmt: f, width, label } = {}) {
  const col = tok(c);
  const s = { type: "bar", name, data, stack, yAxisIndex };
  if (col) s.itemStyle = { color: col };
  if (horizontal && !stack) s.itemStyle = { ...(s.itemStyle || {}), borderRadius: [0, 4, 4, 0] };
  if (width) s.barMaxWidth = width;
  if (label) {
    s.label = {
      show: true,
      position: horizontal ? "right" : "top",
      color: "@text-2",
      fontSize: 11,
      formatter: typeof label === "function" ? (p) => label(p.value, p) : (p) => axisNumber(Array.isArray(p.value) ? p.value[1] : p.value)
    };
  }
  if (f) s.tooltip = { valueFormatter: f };
  return s;
}

// 提示框：tooltip(formatter) 或 tooltip({ trigger, … })。formatter 返回 HTML 字符串（自己负责转义，建议用 tipHtml）
export function tooltip(arg) {
  if (typeof arg === "function") return { formatter: arg };
  return arg || {};
}

// 时间升序的 [[ms, v, …], …] 里离 t 最近的点（二分查找）；离得超过 maxGap 毫秒就当没有
export function nearest(points, t, maxGap = Infinity) {
  if (!points || !points.length || !Number.isFinite(t)) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = points[lo];
  if (lo > 0 && Math.abs(points[lo - 1][0] - t) < Math.abs(best[0] - t)) best = points[lo - 1];
  return Math.abs(best[0] - t) <= maxGap ? best : null;
}

// 几条来自不同查询、时间点对不齐的折线（2 分钟一个点 vs 2 小时一个点）共用的提示框。
// ECharts 的轴提示框只列出「离指针最近的那个时刻」上有点的系列，常常少一半；这里按指针时刻去每条线里二分找最近的点。
// lines：[{ name, data: [[ms, v, …], …]（时间升序）, color, fmt: (v, 点) => 文本, maxGap }]
//   - fmt 返回 null 时这一行不显示；点的其它列也传给 fmt（比如分位带 [ms, 低, 高]）
//   - name 和图里系列同名时，图例关掉那条线，提示框里也跟着不显示；hidden: true 直接不显示
// opts：{ maxGap（毫秒，默认不限）, title: (t, rows) => 标题文字 }
export function nearestTooltip(lines, { maxGap = Infinity, title } = {}) {
  const f = (params, selected) => {
    const list = Array.isArray(params) ? params : [params];
    const t = list.length && list[0] ? +list[0].axisValue : NaN;
    if (!Number.isFinite(t)) return "";
    const rows = [];
    for (const l of lines) {
      if (!l || l.hidden || (selected && l.name != null && selected[l.name] === false)) continue;
      const p = nearest(l.data, t, l.maxGap ?? maxGap);
      if (!p) continue;
      const v = l.fmt ? l.fmt(p[1], p) : typeof p[1] === "number" ? axisNumber(p[1]) : p[1];
      if (v == null) continue;
      rows.push({ color: paintColor(l.color), name: l.name, value: v });
    }
    if (!rows.length) return "";
    return tipHtml(title ? title(t, rows) : timeTitle(t), rows);
  };
  f.__tmNearest = true;
  return { trigger: "axis", formatter: f };
}

// 数据量大时加上缩放：桌面拖动平移、Ctrl/触控板捏合缩放；手机双指缩放，单指仍然滚动页面。
// filterMode 不传时按图里的系列定：全是柱子用 "filter"（纵轴跟着窗口里的柱子变），否则 "none"
export function zoom({ start, end, xAxisIndex, filterMode } = {}) {
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const z = {
    type: "inside",
    xAxisIndex,
    start,
    end,
    zoomOnMouseWheel: "ctrl",
    moveOnMouseWheel: false,
    moveOnMouseMove: !touch,
    preventDefaultMouseMove: !touch
  };
  if (filterMode) z.filterMode = filterMode;
  return [z];
}

// 状态时间线（custom series）：items = [{ lane, start, end, color, name, raw }]
// lane 是 y 轴分类的下标；color 用主题色名；配合 yAxis: categoryAxis([...]) 和 xAxis: timeAxis() 使用。
// opts.tooltip：(item, p) => HTML（自己负责转义，建议用 tipHtml），item 是传进来的那一项（带 raw）；false 不显示提示框。
// 默认提示框：状态名、时间段（fmt.period：「9月21日 23:06–次日 02:52」）、时长。它把 start / end 当毫秒时间；
// 横轴不是时间（比如 0–24 小时）时，在 raw 里放 { start, end }（毫秒）给默认提示框用
export function timelineSeries(items, { name = "状态", height = 0.6, tooltip: tip } = {}) {
  const defaultTip = (p) => {
    const it = items[p.dataIndex] || {};
    const r = it.raw || {};
    const a = Number.isFinite(r.start) ? r.start : p.value[1];
    const b = Number.isFinite(r.end) ? r.end : p.value[2];
    return tipHtml(p.name, [{ color: markerColor(p), name: fmt.period(a, b), value: fmt.duration((b - a) / 60e3) }]);
  };
  return {
    type: "custom",
    name,
    encode: { x: [1, 2], y: 0 },
    renderItem(params, api) {
      const lane = api.value(0);
      const a = api.coord([api.value(1), lane]);
      const b = api.coord([api.value(2), lane]);
      const h = api.size([0, 1])[1] * height;
      const cs = params.coordSys;
      const x = Math.max(a[0], cs.x);
      const x2 = Math.min(b[0], cs.x + cs.width);
      if (x2 <= x) return null;
      // 相邻两段之间留 1px 缝，短到看不见的段至少画 1px
      const w = Math.max(1, x2 - x - (x2 - x > 3 ? 1 : 0));
      return {
        type: "rect",
        shape: { x, y: a[1] - h / 2, width: w, height: h, r: Math.min(3, w / 2) },
        style: { fill: api.visual("color") }
      };
    },
    tooltip:
      tip === false
        ? { show: false }
        : { trigger: "item", formatter: typeof tip === "function" ? (p) => tip(items[p.dataIndex], p) : defaultTip },
    data: items.map((it) => ({ name: it.name, value: [it.lane, it.start, it.end], itemStyle: it.color ? { color: tok(it.color) } : undefined }))
  };
}

// ---------------------------------------------------------------- 按天 / 周 / 月分桶的柱状图

// 跨度（天）不超过 day 按天、不超过 week 按周，再长按月：不然「全部」范围几百根柱子挤成一团
export function bucketKind(from, to, { day = 100, week = 550 } = {}) {
  const span = (to - from) / DAY;
  return span <= day ? "day" : span <= week ? "week" : "month";
}

// ms 所在的桶的起点（本地时间 0 点；周从周一开始）
export function bucketOf(ms, kind = "day") {
  const d = new Date(ms);
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (kind === "week") return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// 下一个桶的起点
export function bucketEnd(ms, kind = "day") {
  const d = new Date(bucketOf(ms, kind));
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (kind === "week" ? 7 : 1)).getTime();
}

// 桶的正中间：柱子画在这里，和坐标轴上的日期对齐（大小月、平闰年都对）
export function bucketMid(ms, kind = "day") {
  const a = bucketOf(ms, kind);
  return a + (bucketEnd(a, kind) - a) / 2;
}

// 提示框标题：「9月24日 周四」/「9月21日 起的一周」/「2026年9月」
export function bucketTitle(ms, kind = "day") {
  const a = bucketOf(ms, kind);
  if (kind === "month") return fmt.month(a);
  if (kind === "week") return `${fmt.dateAuto(a)} 起的一周`;
  return `${fmt.dateAuto(a)} ${fmt.weekday(a)}`;
}

// 分桶柱状图的时间轴：从 from 所在的桶画到 to 所在的桶的末尾（柱子用 bucketMid 放在桶中间，首尾的柱子不会被切）；
// minInterval 按天、按周都是 1 天（刻度不会比一天更密，两三天的范围里不会冒出 18:00 / 06:00 这种刻度），按月是 28 天
export function bucketAxis(kind, from, to, extra = {}) {
  return timeAxis(merge({ min: bucketOf(from, kind), max: bucketEnd(Math.max(from, to - 1), kind), minInterval: kind === "month" ? 28 * DAY : DAY }, extra));
}
