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

// 占比（某部分占总数的百分之几，v 已经是百分数）：取整；会四舍五入成 0% 的写「<1%」、会四舍五入成 100% 的写「>99%」，
// 免得「0%」和「100%」并排、看起来一点都没有 / 全在这一档
export function share(v) {
  if (!ok(v)) return DASH;
  const p = +v;
  return p > 0 && p < 0.5 ? "<1%" : p >= 99.5 && p < 100 ? ">99%" : pct(p);
}

// 显式写正负号的变化量：正数「+」、负数「−」（U+2212，不是连字符），四舍五入成 0 的不带符号：+2.1 / −3.1 / 0。
// f：小数位数；或者格式化绝对值的函数，要带单位时用（signed(v, (x) => fmt.len(x, 0)) →「−12 km」）
export function signed(v, f = 0) {
  if (!ok(v)) return DASH;
  const text = (x) => (typeof f === "function" ? f(x) : num(x, f));
  const s = text(Math.abs(+v));
  return (s === text(0) ? "" : +v < 0 ? "−" : "+") + s;
}

// 大数字压缩：12,345 → "1.2万"
const compactFmt = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
export function compact(v) {
  return ok(v) ? compactFmt.format(+v) : DASH;
}

// 数字和单位之间是不换行空格：统计卡片的小字、列表行折行时「358.6 kWh」整个换到下一行，不拆成「358.6」「kWh」两行
const NBSP = " ";

function withUnit(v, d, u) {
  return ok(v) ? `${num(v, d)}${NBSP}${u}` : DASH;
}

export function len(v, d = 0) {
  return withUnit(v, d, unit.len);
}

// 距离 / 里程的小数位（各页统一）：不到 99.95 一位小数，再大取整（「8.2 km」「318 km」）。
// 边界是 99.95 不是 100：99.96 按一位小数会写成「100.0」，这种也取整。统计卡片写 { value: v, digits: lenDigits(v) }
export function lenDigits(v) {
  return ok(v) && Math.abs(+v) < 99.95 ? 1 : 0;
}

export function lenText(v) {
  return len(v, lenDigits(v));
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

// ---------------------------------------------------------------- 时间段（各页统一的写法）

// 相隔几个自然日（本地时间，只看日期）
function daysApart(a, b) {
  const x = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((y - x) / 86400e3);
}

// 列表行里的日期：今天 / 昨天 / 9月22日（不带星期，省地方；不是今年的带年份）
export function shortDay(ms) {
  const d = day(ms);
  return d === "今天" || d === "昨天" ? d : dateAuto(ms);
}

// 时间段的结束那一头：同一天只写时刻「07:54」，第二天「次日 02:52」，再往后写日期「9月23日 08:00」
export function endTime(start, end) {
  const a = toDate(start);
  const b = toDate(end);
  if (!b) return DASH;
  const days = a ? daysApart(a, b) : 0;
  if (days <= 0) return time(b);
  if (days === 1) return `次日 ${time(b)}`;
  return dateTime(b);
}

// 列表行、统计小字的时间段：「07:37–07:54」，跨午夜「23:06–次日 02:52」，更久「14:05–9月23日 08:00」（「–」两边不加空格）。
// 前面要日期时写 `${shortDay(start)} ${timeSpan(start, end)}`
export function timeSpan(start, end) {
  return `${time(start)}–${endTime(start, end)}`;
}

// 两头都带日期的时间段（统计范围说明、状态条 / 停车的提示框）：同一天「9月21日 14:05–16:57」，第二天结束「9月21日 23:06–次日 02:52」，
// 再往后两头都写日期时间，「–」两边加空格。年份和 dateRange 一样：同一年只在开头带（今年的不带），跨年两头都带——
// 两头各用 dateTime 的话，结束那头是今年、省掉了年份，「2025年9月25日 00:00 – 9月24日 21:42」像是倒着的
export function period(start, end) {
  const a = toDate(start);
  const b = toDate(end);
  if (!a || !b) return DASH;
  if (daysApart(a, b) <= 1) return `${dateAuto(a)} ${timeSpan(a, b)}`;
  if (a.getFullYear() === b.getFullYear()) return `${dateTime(a)} – ${date(b)} ${time(b)}`;
  return `${dateY(a)} ${time(a)} – ${dateY(b)} ${time(b)}`;
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

// 累计驾驶时间（行程页的「驾驶时长」、驾驶统计「共统计了 …」、时间线、旅程）按小时说：「2天5小时」容易被读成日历上的两天，
// 「54.5 小时」也好比较。不到 1 小时照常写「45分」，10 小时以内一位小数，再长取整；边界是 9.95：9.96 按一位小数会写成「10.0」。
// hoursStat 给统计卡片：返回 ui.stats 一格的 { value, digits, unit }（不到 1 小时 value 是 duration 的文字、不带单位）
export function hoursStat(min) {
  if (!ok(min)) return { value: null };
  const h = +min / 60;
  return h < 1 ? { value: duration(min) } : { value: h, digits: h < 9.95 ? 1 : 0, unit: "小时" };
}

export function hours(min) {
  const s = hoursStat(min);
  return s.unit ? withUnit(s.value, s.digits, s.unit) : s.value ?? DASH;
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
