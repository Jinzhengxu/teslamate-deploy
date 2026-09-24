/*
 * 时间范围模型。URL 参数 r：
 *   7d / 30d / 90d / 180d / Nd   最近 N 天（含今天：从 N-1 天前的 0 点到现在）
 *   1y / Ny                      最近 N 年（从 N 年前的明天 0 点到现在）
 *   all                          全部（2010-01-01 起）
 *   2026-09                      某个月
 *   2026                         某一年
 *   20260101-20260315            自定义日期段（含首尾两天）
 * 全部按浏览器本地时间算。「到现在」的 to 取到下一个整分钟：一分钟内反复打开同一页，范围不变，查询能命中缓存。
 *
 * parse(key) → { key, kind, from, to, label, span, step(dir) } | null；step(-1/+1) 返回相邻一段的范围（没有就 null）
 * 标签要在 390 宽的页头按钮里放得下：今年的日期不写年份，带年份的日期段用「2025/12/15 – 2026/1/15」这种短写法。
 */
import * as fmt from "./format.js";
import { html, icon, openSheet, render, closeSheet } from "./ui.js";

export const PRESETS = [
  { key: "7d", label: "近7天" },
  { key: "30d", label: "近30天" },
  { key: "90d", label: "近90天" },
  { key: "1y", label: "近1年" },
  { key: "all", label: "全部" }
];

const ALL_FROM = new Date(2010, 0, 1).getTime();
const DAY_LABEL = { 1: "今天", 180: "近半年" };

function nowMs() {
  return Date.now();
}

function ceilMinute(ms) {
  return Math.ceil(ms / 60e3) * 60e3;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function parseYmd(s) {
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  const date = new Date(y, m - 1, d);
  // 2026-02-30 这类不存在的日期，Date 会自动进位，比对一下就能认出来
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400e3);
}

function make(key, kind, from, to, label, stepFn, span = "") {
  return { key, kind, from, to, label, span, step: stepFn };
}

const slashYmd = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
const slashMd = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

// 自定义日期段的标签。原来的「2025年12月15日 – 2026年1月15日」在 390 宽的页头按钮里被截成「…2026年1月1…」：
//   今年之内   5月1日 – 5月4日（一天就是 5月4日）
//   往年同一年 2025/5/1 – 5/4（一天就是 2025年5月4日）—— 年份不能省，不然看着像今年
//   跨年       2025/12/15 – 2026/1/15
export function customLabel(a, b, now = nowMs()) {
  const one = a.getTime() === b.getTime();
  if (a.getFullYear() === b.getFullYear()) {
    if (a.getFullYear() === new Date(now).getFullYear()) return one ? fmt.date(a) : `${fmt.date(a)} – ${fmt.date(b)}`;
    return one ? fmt.dateY(a) : `${slashYmd(a)} – ${slashMd(b)}`;
  }
  return `${slashYmd(a)} – ${slashYmd(b)}`;
}

// 一段自定义日期（a、b 都是某天 0 点的 Date），结束日是今天或以后时收成「近 N 天」
function customRange(a, b, now) {
  const today = startOfDay(new Date(now));
  if (a > today) return null;
  const len = daysBetween(a, b) + 1;
  if (b >= today) {
    const start = addDays(today, -(len - 1));
    if (start.getTime() === a.getTime()) return parse(`${len}d`, now);
  }
  const to = Math.min(addDays(b, 1).getTime() - 1, ceilMinute(now));
  const key = `${ymd(a)}-${ymd(b)}`;
  return make(key, "custom", a.getTime(), to, customLabel(a, b, now), (dir) => {
    const na = addDays(a, dir * len);
    const nb = addDays(b, dir * len);
    if (na > today) return null;
    return customRange(na, nb > today && dir > 0 ? today : nb, now);
  });
}

export function parse(key, now = nowMs()) {
  if (typeof key !== "string") return null;
  key = key.trim();
  const today = startOfDay(new Date(now));
  const to = ceilMinute(now);
  let m;

  if ((m = /^(\d{1,4})d$/.exec(key))) {
    const n = +m[1];
    if (n < 1 || n > 3650) return null;
    const from = addDays(today, -(n - 1));
    return make(key, "rolling", from.getTime(), to, DAY_LABEL[n] || `近${n}天`, (dir) =>
      dir < 0 ? customRange(addDays(from, -n), addDays(from, -1), now) : null,
    n === 1 ? "" : `${fmt.dateAuto(from)} – 今天`);
  }

  if ((m = /^(\d{1,2})y$/.exec(key))) {
    const n = +m[1];
    if (n < 1 || n > 20) return null;
    const from = addDays(new Date(today.getFullYear() - n, today.getMonth(), today.getDate()), 1);
    return make(key, "rolling", from.getTime(), to, `近${n}年`, (dir) => {
      if (dir > 0) return null;
      const pf = addDays(new Date(from.getFullYear() - n, from.getMonth(), from.getDate()), 0);
      return customRange(pf, addDays(from, -1), now);
    }, `${fmt.dateAuto(from)} – 今天`);
  }

  if (key === "all") {
    return make("all", "all", ALL_FROM, to, "全部", () => null);
  }

  if ((m = /^(\d{4})-(\d{2})$/.exec(key))) {
    const y = +m[1];
    const mon = +m[2];
    if (mon < 1 || mon > 12 || y < 2000 || y > 2100) return null;
    const from = new Date(y, mon - 1, 1);
    if (from > today) return null;
    const end = new Date(y, mon, 1).getTime() - 1;
    const cur = y === today.getFullYear() && mon === today.getMonth() + 1;
    // 今年的月份只写「5月」，往年「2025年5月」
    const label = y === today.getFullYear() ? `${mon}月` : `${y}年${mon}月`;
    return make(key, "month", from.getTime(), Math.min(end, to), label, (dir) => {
      const d = new Date(y, mon - 1 + dir, 1);
      return parse(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, now);
    }, cur ? "本月" : "");
  }

  if ((m = /^(\d{4})$/.exec(key))) {
    const y = +m[1];
    if (y < 2000 || y > 2100) return null;
    const from = new Date(y, 0, 1);
    if (from > today) return null;
    const end = new Date(y + 1, 0, 1).getTime() - 1;
    return make(key, "year", from.getTime(), Math.min(end, to), `${y}年`, (dir) => parse(String(y + dir), now),
      y === today.getFullYear() ? "今年" : "");
  }

  if ((m = /^(\d{8})-(\d{8})$/.exec(key))) {
    const a = parseYmd(m[1]);
    const b = parseYmd(m[2]);
    if (!a || !b || b < a || daysBetween(a, b) > 36600) return null;
    return customRange(a, b, now);
  }
  return null;
}

// 解析失败时退回页面默认值，再不行就「近 30 天」
export function resolve(key, fallback = "30d", now = nowMs()) {
  return (key && parse(key, now)) || parse(fallback, now) || parse("30d", now);
}

// 页面的默认范围：export const range = { default: "90d" | (searchParams) => key }。
// 函数按当前查询参数算（按月汇总：period=day 时近30天，否则近1年）；抛错或没给时用「近30天」
export function defaultKey(spec, query = new URLSearchParams()) {
  const d = spec && spec.default;
  if (typeof d !== "function") return d || "30d";
  try {
    return d(new URLSearchParams(query)) || "30d";
  } catch (e) {
    console.warn("[stats] range.default 出错，用近30天", e);
    return "30d";
  }
}

// 画时间轴用的起点：范围早于这辆车最早的记录（「全部」从 2010 年算、「近2年」而车才接入一年）时，从最早的记录算起，
// 不然图表挤在最右边一小条。since 不在范围里（没记录，或整段都在接入之前）时照旧用 from
export function effectiveFrom(r, since) {
  if (!r) return null;
  return typeof since === "number" && since > r.from && since < r.to ? since : r.from;
}

// 选择面板里「本月 / 上月 / 今年 / 去年」对应的 key
export function calendarPresets(now = nowMs()) {
  const d = new Date(now);
  const mk = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return [
    { key: mk(d.getFullYear(), d.getMonth()), label: "本月" },
    { key: mk(prev.getFullYear(), prev.getMonth()), label: "上月" },
    { key: String(d.getFullYear()), label: "今年" },
    { key: String(d.getFullYear() - 1), label: "去年" }
  ];
}

// ---------------------------------------------------------------- 页头的范围选择器

// 一行：‹ [日历图标 近90天 · 6月27日 – 今天 ⌄] ›
export function bar(r) {
  const prev = r.step(-1);
  const next = r.step(1);
  const full = r.span ? `${r.label}（${r.span}）` : r.label;
  return html`<div class="tm-rangebar" role="group" aria-label="时间范围">
    <button type="button" class="tm-rb-step" data-range-step="-1" aria-label="上一段"${prev ? "" : html` disabled`}>${icon("chevron-left")}</button>
    <button type="button" class="tm-rb-label" data-range-open aria-haspopup="dialog" aria-expanded="false" title="${full}">
      ${icon("calendar-range")}<span class="tm-rb-text">${r.label}</span>${r.span ? html`<span class="tm-rb-span">${r.span}</span>` : ""}
    </button>
    <button type="button" class="tm-rb-step" data-range-step="1" aria-label="下一段"${next ? "" : html` disabled`}>${icon("chevron-right")}</button>
  </div>`;
}

// 默认范围要先查库才知道时（range.auto）的占位：和真的范围条一样大、按钮都不能点，
// 算出来之前不显示任何范围文字（不能先闪一下别的范围），页头也不会因为范围条后出现而跳一下
export function barPending() {
  return html`<div class="tm-rangebar" role="group" aria-label="时间范围" aria-busy="true">
    <button type="button" class="tm-rb-step" aria-label="上一段" disabled>${icon("chevron-left")}</button>
    <button type="button" class="tm-rb-label" disabled>${icon("calendar-range")}<span class="tm-rb-text">…</span></button>
    <button type="button" class="tm-rb-step" aria-label="下一段" disabled>${icon("chevron-right")}</button>
  </div>`;
}

function dateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 打开选择面板。onPick(key) 选定后回调
export function openPicker(anchor, current, onPick, { defaultKey } = {}) {
  const presets = PRESETS.slice();
  // 页面默认值不在常用预设里（比如近半年）时也放进去，方便回到默认
  for (const k of [defaultKey, current.kind === "rolling" ? current.key : null]) {
    if (k && !presets.some((p) => p.key === k)) {
      const r = parse(k);
      if (r) presets.splice(presets.length - 1, 0, { key: k, label: r.label });
    }
  }
  const chip = (p) =>
    html`<button type="button" class="tm-chip" data-key="${p.key}" aria-pressed="${p.key === current.key ? "true" : "false"}">${p.label}</button>`;
  const today = dateInput(Date.now());
  const content = html`<div class="tm-rp">
    <div class="tm-rp-group"><h3>最近</h3><div class="tm-rp-chips">${presets.map(chip)}</div></div>
    <div class="tm-rp-group"><h3>按月 / 按年</h3><div class="tm-rp-chips">${calendarPresets().map(chip)}</div></div>
    <form class="tm-rp-group" data-custom>
      <h3>自定义</h3>
      <div class="tm-rp-custom">
        <label>开始<input class="tm-input" type="date" name="from" required min="2010-01-01" max="${today}" value="${dateInput(current.from)}"></label>
        <label>结束<input class="tm-input" type="date" name="to" required min="2010-01-01" max="${today}" value="${dateInput(Math.min(current.to - 1, Date.now()))}"></label>
        <button type="submit" class="tm-btn is-primary">确定</button>
      </div>
    </form>
  </div>`;
  const box = document.createElement("div");
  render(box, content);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-key]");
    if (!b) return;
    closeSheet();
    onPick(b.dataset.key);
  });
  // 报过一次「日期不对」后，改了日期要清掉，不然表单一直提交不了
  box.querySelector("form").addEventListener("input", (e) => e.currentTarget.to.setCustomValidity(""));
  box.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    let a = f.from.value.replace(/-/g, "");
    let b = f.to.value.replace(/-/g, "");
    if (!/^\d{8}$/.test(a) || !/^\d{8}$/.test(b)) return;
    if (a > b) [a, b] = [b, a];
    const r = parse(`${a}-${b}`);
    if (!r) {
      f.to.setCustomValidity("日期不对");
      f.to.reportValidity();
      return;
    }
    closeSheet();
    onPick(r.key);
  });
  return openSheet(anchor, box, { title: "时间范围", wide: true });
}
