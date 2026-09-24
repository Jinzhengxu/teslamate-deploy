/*
 * 数字 / 单位 / 日期 / 时长的中文格式化。
 *   - 值是 null、undefined、NaN、±Infinity 时一律返回「—」；
 *   - 单位跟随 TeslaMate 设置（app.js 启动时调 configure）。SQL 已经按 $length_unit 等换算好了，这里只负责加单位；
 *   - 时间一律按浏览器本地时区显示（Date 的本地 getter），传入的是毫秒时间戳（api 返回的时间列就是毫秒）。
 */

export const DASH = "—";

const units = {
  lengthUnit: "km",
  tempUnit: "C",
  pressureUnit: "bar"
};

export function configure(settings) {
  if (!settings) return;
  if (settings.lengthUnit === "mi" || settings.lengthUnit === "km") units.lengthUnit = settings.lengthUnit;
  if (settings.tempUnit === "F" || settings.tempUnit === "C") units.tempUnit = settings.tempUnit;
  if (settings.pressureUnit === "psi" || settings.pressureUnit === "bar") units.pressureUnit = settings.pressureUnit;
}

// 当前的单位文字，给图表坐标轴、表头用
export const unit = {
  get len() {
    return units.lengthUnit;
  },
  get speed() {
    return units.lengthUnit === "mi" ? "mph" : "km/h";
  },
  get temp() {
    return units.tempUnit === "F" ? "°F" : "°C";
  },
  get cons() {
    return units.lengthUnit === "mi" ? "Wh/mi" : "Wh/km";
  },
  get pressure() {
    return units.pressureUnit;
  },
  // 小距离（海拔、爬升）：km → m，mi → ft
  get altLen() {
    return units.lengthUnit === "mi" ? "ft" : "m";
  }
};

function ok(v) {
  return v != null && v !== "" && Number.isFinite(+v);
}

const nfCache = new Map();
function nf(d) {
  let f = nfCache.get(d);
  if (!f) {
    f = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
    nfCache.set(d, f);
  }
  return f;
}

// 1234.5 → "1,234.5"。d 位小数（默认 0）。-0 显示成 0
export function num(v, d = 0) {
  if (!ok(v)) return DASH;
  const s = nf(d).format(+v);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

export function int(v) {
  return num(v, 0);
}

// v 已经是百分数（87.5 → "87.5%"），不是 0~1 的小数
export function pct(v, d = 0) {
  return ok(v) ? num(v, d) + "%" : DASH;
}

// 大数字压缩：12,345 → "1.2万"
const compactFmt = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
export function compact(v) {
  return ok(v) ? compactFmt.format(+v) : DASH;
}

function withUnit(v, d, u) {
  return ok(v) ? `${num(v, d)} ${u}` : DASH;
}

export function len(v, d = 0) {
  return withUnit(v, d, unit.len);
}

export function speed(v, d = 0) {
  return withUnit(v, d, unit.speed);
}

export function temp(v, d = 1) {
  return ok(v) ? num(v, d) + unit.temp : DASH;
}

export function kwh(v, d = 1) {
  return withUnit(v, d, "kWh");
}

export function kw(v, d = 0) {
  return withUnit(v, d, "kW");
}

// 能耗：Wh/km 或 Wh/mi
export function cons(v, d = 0) {
  return withUnit(v, d, unit.cons);
}

export function money(v, d = 2) {
  if (!ok(v)) return DASH;
  return (+v < 0 ? "-¥" : "¥") + num(Math.abs(+v), d);
}

export function pressure(v) {
  return withUnit(v, units.pressureUnit === "psi" ? 0 : 1, unit.pressure);
}

// 海拔、爬升这类小距离：m / ft
export function alt(v, d = 0) {
  return withUnit(v, d, unit.altLen);
}

// ---------------------------------------------------------------- 日期

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function toDate(ms) {
  if (ms instanceof Date) return Number.isFinite(ms.getTime()) ? ms : null;
  if (ms == null || ms === "") return null;
  const d = new Date(typeof ms === "string" && /^\d+$/.test(ms) ? +ms : ms);
  return Number.isFinite(d.getTime()) ? d : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// 9月24日
export function date(ms) {
  const d = toDate(ms);
  return d ? `${d.getMonth() + 1}月${d.getDate()}日` : DASH;
}

// 2026年9月24日
export function dateY(ms) {
  const d = toDate(ms);
  return d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : DASH;
}

// 今年的省略年份：9月24日 / 2025年9月24日
export function dateAuto(ms) {
  const d = toDate(ms);
  if (!d) return DASH;
  return d.getFullYear() === new Date().getFullYear() ? date(d) : dateY(d);
}

// 2026-09-24（表格里需要对齐时用）
export function isoDate(ms) {
  const d = toDate(ms);
  return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : DASH;
}

// 周一
export function weekday(ms) {
  const d = toDate(ms);
  return d ? WEEK[d.getDay()] : DASH;
}

// 今天 / 昨天 / 9月22日 周一（不是今年的带年份）
export function day(ms) {
  const d = toDate(ms);
  if (!d) return DASH;
  const now = new Date();
  if (sameDay(d, now)) return "今天";
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, y)) return "昨天";
  return `${dateAuto(d)} ${WEEK[d.getDay()]}`;
}

// 14:05
export function time(ms) {
  const d = toDate(ms);
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : DASH;
}

// 9月24日 14:05（不是今年的带年份）
export function dateTime(ms) {
  const d = toDate(ms);
  return d ? `${dateAuto(d)} ${time(d)}` : DASH;
}

// 2026年9月
export function month(ms) {
  const d = toDate(ms);
  return d ? `${d.getFullYear()}年${d.getMonth() + 1}月` : DASH;
}

// 2026年
export function year(ms) {
  const d = toDate(ms);
  return d ? `${d.getFullYear()}年` : DASH;
}

// 9月1日 – 9月15日（跨年或不是今年时带年份）
export function dateRange(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return DASH;
  const thisYear = new Date().getFullYear();
  if (a.getFullYear() === b.getFullYear()) {
    const head = a.getFullYear() === thisYear ? date(a) : dateY(a);
    return sameDay(a, b) ? head : `${head} – ${date(b)}`;
  }
  return `${dateY(a)} – ${dateY(b)}`;
}

// ---------------------------------------------------------------- 时长（参数是分钟）

// 1小时5分 / 45分 / 2天3小时 / 30秒
export function duration(min) {
  if (!ok(min)) return DASH;
  const m = Math.abs(+min);
  const sign = +min < 0 ? "-" : "";
  // 0.995 分钟四舍五入是 60 秒，这时按「1分」显示
  if (Math.round(m * 60) < 60) return `${sign}${Math.round(m * 60)}秒`;
  let total = Math.round(m);
  const days = Math.floor(total / 1440);
  total -= days * 1440;
  const hours = Math.floor(total / 60);
  const mins = total - hours * 60;
  if (days > 0) return `${sign}${days}天${hours ? hours + "小时" : ""}`;
  if (hours > 0) return `${sign}${hours}小时${mins ? mins + "分" : ""}`;
  return `${sign}${mins}分`;
}

// 更短的写法，给坐标轴、窄表格用：45分 / 1.5小时 / 2.3天
export function durationShort(min) {
  if (!ok(min)) return DASH;
  const m = +min;
  const a = Math.abs(m);
  if (a < 60) return `${num(m, 0)}分`;
  if (a < 1440) return `${num(m / 60, a < 600 ? 1 : 0)}小时`;
  return `${num(m / 1440, a < 14400 ? 1 : 0)}天`;
}

// 3分钟前 / 2小时前 / 昨天 / 5天前 / 9月1日
export function rel(ms) {
  const d = toDate(ms);
  if (!d) return DASH;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const a = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (a < 60e3) return "刚刚";
  if (a < 3600e3) return `${Math.floor(a / 60e3)}分钟${suffix}`;
  if (a < 86400e3 && (diff < 0 || sameDay(d, now))) return `${Math.floor(a / 3600e3)}小时${suffix}`;
  if (diff > 0) {
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (sameDay(d, y)) return "昨天";
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400e3);
    if (days < 7) return `${days}天前`;
  }
  return dateAuto(d);
}
