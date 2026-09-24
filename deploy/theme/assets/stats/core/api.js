/*
 * Grafana 查询客户端：POST /grafana/api/ds/query（TeslaMate 数据源），同域请求，登录由 Caddy 的 cookie 负责。
 *
 *   batch({ key: sql | { sql, vars, format, intervalMs, maxDataPoints, cache, range } }, opts) → { key: rows }
 *   sql(sql, opts) → rows
 *   rows 是对象数组（列名为键），另外挂着 rows.fields = [{ name, type }]；时间列是毫秒数。
 *
 * 变量替换在这里做（Grafana 前端变量），$__timeFilter(...) 这类宏原样交给 Grafana 后端。
 * 同一 (SQL, 变量, 范围) 60 秒内复用结果。请求一旦发出不会中途取消（服务器那边也不会停），
 * signal 只决定调用方还等不等结果；没人等的结果照样进缓存，返回页面时直接用。
 *
 * 用户输入的文字进 SQL 一律用 text() / like()（十六进制写法），不要用 lit()：
 * lit() 拼出的 '…' 之后还要经过前端的 $变量替换，Grafana 后端还会展开字符串字面量里的 $__timeFrom() 这类宏。
 */

const GRAFANA = "/grafana";
const DS_NAME = "TeslaMate";
const DS_KEY = "tm-stats-ds";
const TTL = 60e3;

export let settings = null;
export let cars = [];
export let datasourceUid = null;

// app.js 每次渲染页面前设置：公共变量（car_id 等）和默认时间范围
let baseVars = {};
let defaultRange = null;

export function setContext({ vars, range } = {}) {
  if (vars) baseVars = { ...vars };
  defaultRange = range || null;
}

export class ApiError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- 变量替换

// Grafana 后端处理的宏：不替换
const MACROS = new Set([
  "__time", "__timeEpoch", "__timeFilter", "__timeFrom", "__timeTo", "__timeGroup", "__timeGroupAlias",
  "__unixEpochFilter", "__unixEpochFrom", "__unixEpochTo", "__unixEpochGroup", "__unixEpochGroupAlias",
  "__unixEpochNanoFilter", "__unixEpochNanoFrom", "__unixEpochNanoTo", "__interval", "__interval_ms",
  "__schema", "__table", "__column"
]);

// ${name} ${name:fmt} [[name]] [[name:fmt]] $name。名字按最长的标识符匹配（和 Grafana 一样），
// 所以 $length_unit 不会被当成 $length 加 _unit，$__timezone 也不会被当成宏 $__time
const VAR_RE = /\$\{([A-Za-z_]\w*)(?::([^}]*))?\}|\[\[([A-Za-z_]\w*)(?::([^\]]*))?\]\]|\$([A-Za-z_]\w*)/g;

const warned = new Set();
function defaultWarn(name, token) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[stats] SQL 里的变量 ${token} 没有值，原样保留`);
}

function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const INTERVALS = [
  [1e3, "1s"], [5e3, "5s"], [10e3, "10s"], [15e3, "15s"], [30e3, "30s"], [60e3, "1m"], [300e3, "5m"], [600e3, "10m"],
  [900e3, "15m"], [1800e3, "30m"], [3600e3, "1h"], [10800e3, "3h"], [21600e3, "6h"], [43200e3, "12h"], [86400e3, "1d"],
  [604800e3, "7d"], [2592000e3, "30d"], [31536000e3, "1y"]
];

// 和 Grafana 的思路一样：范围 / 点数，取不小于它的「整」间隔
export function autoInterval(range, maxDataPoints = 1000) {
  const raw = Math.max(1, (range.to - range.from) / Math.max(1, maxDataPoints));
  for (const [ms] of INTERVALS) if (raw <= ms) return ms;
  return INTERVALS[INTERVALS.length - 1][0];
}

function intervalText(ms) {
  const hit = INTERVALS.find(([v]) => v === ms);
  if (hit) return hit[1];
  return ms % 1000 === 0 ? ms / 1000 + "s" : ms + "ms";
}

function builtins(range, intervalMs) {
  const from = range.from;
  const to = range.to;
  const s = Math.round((to - from) / 1000);
  return {
    __from: from,
    __to: to,
    __timezone: timezone(),
    __range_ms: to - from,
    __range_s: s,
    __range: s + "s",
    __url_time_range: { value: `from=${from}&to=${to}`, raw: true },
    // 花括号写法 ${__interval} 只有前端认识；不带花括号的 $__interval 交给后端（两边算出来一样）
    __interval: intervalText(intervalMs),
    __interval_ms: intervalMs
  };
}

function scalar(x, name) {
  if (x instanceof Date) x = x.getTime();
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new ApiError(`变量 ${name} 不是有效的数字：${x}`);
    return String(x);
  }
  if (typeof x === "boolean") return String(x);
  if (x == null) throw new ApiError(`变量 ${name} 的值是空的`);
  return String(x);
}

const sqlQuote = (s) => "'" + s.replace(/\u0000/g, "").replace(/'/g, "''") + "'";
const reEscape = (s) => s.replace(/[\\^$*+?.()|[\]{}\/]/g, "\\$&");

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

// ${__from:date:…}：iso（默认）、seconds，或 YYYY-MM-DD HH:mm:ss 这类（按浏览器本地时间）
function formatDate(v, arg, name) {
  const ms = v instanceof Date ? v.getTime() : typeof v === "string" && /^-?\d+$/.test(v) ? +v : v;
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw new ApiError(`变量 ${name} 不是时间，不能用 :date 格式`);
  if (!arg || arg === "iso") return new Date(ms).toISOString();
  if (arg === "seconds") return String(Math.floor(ms / 1000));
  const d = new Date(ms);
  const tokens = {
    YYYY: () => String(d.getFullYear()), YY: () => pad(d.getFullYear() % 100), MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1), DD: () => pad(d.getDate()), D: () => String(d.getDate()),
    HH: () => pad(d.getHours()), H: () => String(d.getHours()), mm: () => pad(d.getMinutes()),
    m: () => String(d.getMinutes()), ss: () => pad(d.getSeconds()), s: () => String(d.getSeconds()),
    SSS: () => pad(d.getMilliseconds(), 3)
  };
  return arg.replace(/YYYY|YY|SSS|MM|DD|HH|mm|ss|M|D|H|m|s/g, (t) => tokens[t]());
}

// 把一个变量值按格式变成 SQL 文本。值可以是：字符串、数字、布尔、Date、数组（多选）、{ value, text }
export function formatValue(v, spec, name = "?", warn = defaultWarn) {
  let value = v;
  let text;
  if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
    value = v.value;
    text = v.text;
    if (v.raw && !spec) return String(value);
  }
  const i = spec ? spec.indexOf(":") : -1;
  const fmtName = spec ? (i < 0 ? spec : spec.slice(0, i)) : "";
  const arg = i < 0 ? undefined : spec.slice(i + 1);
  const multi = Array.isArray(value);
  const vals = multi ? value.map((x) => scalar(x, name)) : [scalar(value, name)];
  switch (fmtName) {
    case "":
      // Grafana 的 Postgres 数据源：单值不加引号，但字符串里的单引号要加倍（所以 '$x' 这种写法是安全的）；
      // 多值逐个加引号用逗号连（空数组给 NULL，免得 in () 语法错）
      if (multi) return vals.length ? vals.map(sqlQuote).join(",") : "NULL";
      return typeof value === "string" ? vals[0].replace(/'/g, "''") : vals[0];
    case "raw":
    case "csv":
      return vals.join(",");
    case "text":
      if (text != null) return Array.isArray(text) ? text.join(" + ") : String(text);
      return vals.join(" + ");
    case "sqlstring":
      return vals.length ? vals.map(sqlQuote).join(",") : "NULL";
    case "singlequote":
      return vals.map((s) => "'" + s.replace(/'/g, "\\'") + "'").join(",");
    case "doublequote":
      return vals.map((s) => '"' + s.replace(/"/g, '\\"') + '"').join(",");
    case "pipe":
      return vals.join("|");
    case "json":
      return JSON.stringify(value instanceof Date ? value.getTime() : value);
    case "regex":
      return multi && vals.length > 1 ? "(" + vals.map(reEscape).join("|") + ")" : reEscape(vals[0] ?? "");
    case "percentencode":
      return encodeURIComponent(multi ? "{" + vals.join(",") + "}" : vals[0]);
    case "glob":
      return multi && vals.length > 1 ? "{" + vals.join(",") + "}" : vals[0] ?? "";
    case "queryparam":
      return vals.map((s) => `var-${encodeURIComponent(name)}=${encodeURIComponent(s)}`).join("&");
    case "date":
      return formatDate(multi ? value[0] : value, arg, name);
    default:
      warn(name + ":" + fmtName, `\${${name}:${spec}}（不认识的格式 ${fmtName}，按默认格式处理）`);
      return formatValue(v, "", name, warn);
  }
}

// 替换 SQL 里的变量。vars 里的值覆盖内置变量；没有值的变量原样保留并警告
export function interpolate(sql, vars = {}, range = defaultRangeValue(), { intervalMs, warn = defaultWarn } = {}) {
  const b = builtins(range, intervalMs || autoInterval(range));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;
  return String(sql).replace(VAR_RE, (m, bName, bFmt, oName, oFmt, pName) => {
    const name = bName || oName || pName;
    const spec = bName ? bFmt : oName ? oFmt : undefined;
    if (pName && MACROS.has(name)) return m;
    const v = has(vars, name) ? vars[name] : has(b, name) ? b[name] : undefined;
    if (v === undefined) {
      warn(name, m);
      return m;
    }
    return formatValue(v, spec, name, warn);
  });
}

// ---------------------------------------------------------------- 数据帧 → 行对象

const ENTITY = [["NaN", NaN], ["Inf", Infinity], ["NegInf", -Infinity], ["Undef", null]];

function decode(v, type) {
  if (v == null) return null;
  if (type === "time" && typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : v;
  }
  if (type === "number" && typeof v === "string" && v !== "" && Number.isFinite(+v)) return +v;
  return v;
}

export function frameToRows(frame) {
  const fields = (frame && frame.schema && frame.schema.fields) || [];
  const values = (frame && frame.data && frame.data.values) || [];
  const entities = (frame && frame.data && frame.data.entities) || [];
  const cols = fields.map((f, j) => {
    let col = values[j] || [];
    const ent = entities[j];
    if (ent) {
      col = col.slice();
      for (const [k, val] of ENTITY) for (const idx of ent[k] || []) col[idx] = val;
    }
    return col;
  });
  // 列名当键。time_series 格式带 metric 列、又有多个值列时，Grafana 回一个宽表，同名的列靠 labels 区分
  // （比如两个 n，labels 分别是 {metric:"1"}、{metric:"2"}）：这时键名写成「n 1」「n 2」，不然后一列会盖掉前一列
  const names = fields.map((f) => f.name);
  const keys = [];
  fields.forEach((f, j) => {
    const dup = names.indexOf(f.name) !== names.lastIndexOf(f.name);
    const lv = f.labels ? Object.values(f.labels).join(" ") : "";
    let k = dup && lv ? `${f.name} ${lv}` : f.name;
    // 还撞名（SQL 里两列同名）：后面的加序号
    for (let n = 2; keys.includes(k); n++) k = `${f.name} ${n}`;
    keys.push(k);
  });
  const n = cols.reduce((m, c) => Math.max(m, c.length), 0);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {};
    for (let j = 0; j < fields.length; j++) r[keys[j]] = decode(cols[j][i], fields[j].type);
    rows[i] = r;
  }
  rows.fields = fields.map((f, j) => (f.labels ? { name: keys[j], type: f.type, labels: f.labels } : { name: keys[j], type: f.type }));
  return rows;
}

function resultToRows(res) {
  const frames = (res && res.frames) || [];
  if (frames.length <= 1) return frameToRows(frames[0]);
  // time_series 格式会按序列拆成多个帧：拼起来，各帧也单独给
  const parts = frames.map(frameToRows);
  const rows = [].concat(...parts);
  rows.fields = parts[0].fields;
  rows.frames = parts;
  return rows;
}

// ---------------------------------------------------------------- 请求

function storage(fn) {
  try {
    return fn(window.localStorage);
  } catch {
    return null;
  }
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
  } catch {
    throw new ApiError("网络连接失败", { network: true });
  }
  if (res.status === 401) throw new ApiError("登录已过期", { status: 401, auth: true });
  const body = await res.json().catch(() => null);
  return { res, body };
}

// 一次 batch 里不同范围的查询会并发发出几个请求：第一次打开、或者 uid 失效要重取时，只查一次数据源
let dsPending = null;

export async function ensureDatasource(force = false) {
  if (!force && datasourceUid) return datasourceUid;
  if (!force) {
    const cached = storage((s) => s.getItem(DS_KEY));
    if (cached) return (datasourceUid = cached);
  }
  if (dsPending) return dsPending;
  dsPending = (async () => {
    const { res, body } = await getJson(`${GRAFANA}/api/datasources/name/${encodeURIComponent(DS_NAME)}`);
    if (!res.ok || !body || !body.uid) {
      const msg = (body && body.message) || `HTTP ${res.status}`;
      throw new ApiError(`找不到 Grafana 里的 TeslaMate 数据源（${msg}）`, { status: res.status });
    }
    datasourceUid = body.uid;
    storage((s) => s.setItem(DS_KEY, body.uid));
    return datasourceUid;
  })();
  try {
    return await dsPending;
  } finally {
    dsPending = null;
  }
}

async function post(body) {
  let res;
  try {
    res = await fetch(`${GRAFANA}/api/ds/query`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new ApiError("网络连接失败", { network: true });
  }
  // 登录过期时 Caddy 直接回 401 + 登录页（不是 JSON）
  if (res.status === 401) throw new ApiError("登录已过期", { status: 401, auth: true });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 下面按非 JSON 处理 */
  }
  // 有查询出错时 Grafana 回 400，但 results 里其它查询的结果照样在
  if (data && data.results) return data.results;
  const msg = data ? data.message || data.error || "" : "";
  if (res.status === 404 && /data ?source not found/i.test(msg)) {
    throw new ApiError("TeslaMate 数据源不存在", { status: 404, dsMissing: true });
  }
  if (res.status >= 502 && res.status <= 504) {
    throw new ApiError(`Grafana 暂时连不上（HTTP ${res.status}），稍后再试`, { status: res.status });
  }
  throw new ApiError(`Grafana 返回错误（HTTP ${res.status}）${msg ? "：" + msg : data ? "" : "：返回的不是 JSON"}`, { status: res.status });
}

// 同一批里还没缓存的查询合成一次请求
async function request(list, range) {
  const build = (uid) => ({
    queries: list.map((q) => ({
      refId: q.refId,
      datasource: { uid },
      rawSql: q.sql,
      format: q.format,
      intervalMs: q.intervalMs,
      maxDataPoints: q.maxDataPoints
    })),
    from: String(Math.round(range.from)),
    to: String(Math.round(range.to))
  });
  let results;
  try {
    results = await post(build(await ensureDatasource()));
  } catch (e) {
    // 缓存的数据源 uid 过期了（比如 Grafana 重装过）：重新取一次再试
    if (!e.dsMissing) throw e;
    results = await post(build(await ensureDatasource(true)));
  }
  const out = {};
  for (const q of list) {
    const r = results[q.refId];
    if (!r) out[q.refId] = new ApiError(`查询「${q.key}」没有返回结果`, { key: q.key });
    else if (r.error) out[q.refId] = new ApiError(`查询「${q.key}」出错：${r.error}`, { key: q.key, sql: q.sql, status: r.status });
    else out[q.refId] = resultToRows(r);
  }
  return out;
}

// ---------------------------------------------------------------- 缓存

const cache = new Map();

export function clearCache() {
  cache.clear();
}

function prune(now) {
  for (const [k, v] of cache) if (now - v.t > TTL) cache.delete(k);
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("页面已离开", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("页面已离开", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

// ---------------------------------------------------------------- 对外接口

// 缓存里的结果是多个调用方共用的：每次交出去一个新数组，页面 sort / reverse / push 不会改到缓存
// （否则 60 秒内重画一次，reverse 过的列表又被倒回去）。行对象本身还是共用的，别改它的字段
function copyRows(rows) {
  const c = rows.slice();
  c.fields = rows.fields;
  if (rows.frames) c.frames = rows.frames;
  return c;
}

function defaultRangeValue() {
  const to = Math.ceil(Date.now() / 60e3) * 60e3;
  return { from: to - 10 * 365.25 * 86400e3, to };
}

function normRange(r) {
  if (r && Number.isFinite(+r.from) && Number.isFinite(+r.to)) return { from: +r.from, to: +r.to };
  return defaultRangeValue();
}

// 单条查询自带的范围：写错了要报出来，不能悄悄退回近 10 年（数字会错得看不出来）
function queryRange(r, key) {
  const from = r && +r.from;
  const to = r && +r.to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new ApiError(`查询「${key}」的 range 不对：要 { from, to } 毫秒数`);
  }
  return { from, to };
}

// queries: { key: sql | { sql, vars, format, intervalMs, maxDataPoints, cache, range } }
// opts: { signal, range, vars, intervalMs, maxDataPoints, cache = true, tolerant = false }
// tolerant: true 时某条查询出错不抛异常，这一项返回空数组，rows.error 是错误
// 单条查询的 range 覆盖 opts.range。Grafana 的 /api/ds/query 只认请求体顶层的 from / to（单条查询里的 timeRange 会被忽略），
// 所以按范围分组，每组一个请求，几组并发发出
export async function batch(queries, opts = {}) {
  // 页面已经离开还在调（比如 catch 住错误后接着查明细）：别再发请求，更别用上新页面的车和范围
  if (opts.signal && opts.signal.aborted) throw new DOMException("页面已离开", "AbortError");
  const range = normRange(opts.range || defaultRange);
  const now = Date.now();
  prune(now);
  const groups = new Map(); // "from-to" → { range, list }
  const keys = Object.keys(queries);
  const promises = {};
  keys.forEach((key, i) => {
    const q = queries[key];
    if (q == null) return;
    const spec = typeof q === "string" ? { sql: q } : q;
    if (!spec.sql) throw new ApiError(`查询「${key}」没有 SQL`);
    const r = spec.range ? queryRange(spec.range, key) : range;
    const maxDataPoints = spec.maxDataPoints || opts.maxDataPoints || 1000;
    const intervalMs = spec.intervalMs || opts.intervalMs || autoInterval(r, maxDataPoints);
    const vars = { ...baseVars, ...(opts.vars || {}), ...(spec.vars || {}) };
    const sql = interpolate(spec.sql, vars, r, { intervalMs });
    const format = spec.format || "table";
    const cacheKey = JSON.stringify([format, intervalMs, maxDataPoints, r.from, r.to, sql]);
    const useCache = opts.cache !== false && spec.cache !== false;
    const hit = useCache && cache.get(cacheKey);
    if (hit) {
      promises[key] = hit.p;
      return;
    }
    // 键名本身能当 refId 就用它；不能时编一个，并且不能和别的键撞名（比如另有一个键就叫 q1）
    let refId = /^[A-Za-z_][\w-]{0,40}$/.test(key) ? key : "q" + i;
    while (refId !== key && Object.prototype.hasOwnProperty.call(queries, refId)) refId = "_" + refId;
    const gk = `${Math.round(r.from)}-${Math.round(r.to)}`;
    if (!groups.has(gk)) groups.set(gk, { range: r, list: [] });
    groups.get(gk).list.push({ key, refId, sql, format, intervalMs, maxDataPoints, cacheKey });
  });

  for (const g of groups.values()) {
    const all = request(g.list, g.range);
    for (const q of g.list) {
      const p = all.then((out) => {
        const r = out[q.refId];
        if (r instanceof Error) throw r;
        return r;
      });
      // 失败的不缓存
      p.catch(() => cache.delete(q.cacheKey));
      cache.set(q.cacheKey, { t: now, p });
      promises[q.key] = p;
    }
  }

  const out = {};
  await abortable(
    Promise.all(
      Object.keys(promises).map(async (key) => {
        try {
          out[key] = copyRows(await promises[key]);
        } catch (e) {
          if (!opts.tolerant || e.auth || e.network) throw e;
          const rows = [];
          rows.fields = [];
          rows.error = e;
          out[key] = rows;
        }
      })
    ),
    opts.signal
  );
  return out;
}

export async function sql(query, opts = {}) {
  const r = await batch({ q: query }, opts);
  return r.q;
}

// ---------------------------------------------------------------- 参数校验（进 SQL 之前必须过一道）

// SQL 字符串字面量：'…'（单引号加倍）。只给代码里写死的常量用：
// 结果之后还要做一次 $变量替换，Grafana 后端还会展开里面的 $__timeFrom() 这类宏，用户输入的文字要用 text() / like()
export function lit(str) {
  if (str == null) return "NULL";
  return sqlQuote(String(str));
}

const utf8 = new TextEncoder();

// 把文字写成 convert_from(decode('<UTF-8 的十六进制>', 'hex'), 'UTF8')：十六进制里只有 0-9a-f，
// 前端的 $变量替换、Grafana 后端的宏展开（它连字符串字面量里的 $__timeFrom() 都会展开）都碰不到它
function hexText(s) {
  const bytes = utf8.encode(s.replace(/\u0000/g, ""));
  let hex = "";
  for (const b of bytes) hex += (b < 16 ? "0" : "") + b.toString(16);
  return `convert_from(decode('${hex}', 'hex'), 'UTF8')`;
}

// 用户输入的文字（搜索词等）当 SQL 文本值：where name = ${api.text(q)}。null → NULL
export function text(str) {
  if (str == null) return "NULL";
  return hexText(String(str));
}

// 「包含」匹配的 ILIKE 模式：where name ilike ${api.like(q)}。
// 前后加 %，文字里的 \ % _ 转义成普通字符（Postgres 的 LIKE 默认用 \ 转义）。null → NULL
export function like(str) {
  if (str == null) return "NULL";
  return hexText("%" + String(str).replace(/[\\%_]/g, "\\$&") + "%");
}

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// 严格转整数：只接受整数或纯数字字符串。不合法时：给了 fallback 就返回它（可选的筛选参数用），
// 没给就抛 badParam 错误（路由参数用，路由会显示「找不到这条记录」）
export function int(x, opts = {}) {
  const { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  const s = typeof x === "number" ? String(x) : typeof x === "string" ? x.trim() : "";
  const n = /^-?\d{1,16}$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    if (hasOwn(opts, "fallback")) return opts.fallback;
    throw new ApiError(`链接里的编号不对：${String(x).slice(0, 40)}`, { status: 400, badParam: true });
  }
  return n;
}

// 逗号分隔的整数列表（URL 里的多选，如 geofence=3,7）："1,2,x,2" → [1, 2]。
// 不合法的项跳过、去重、保持原顺序，最多 max 个；从不抛错。也接受数组（URLSearchParams.getAll 的结果）。
// 每项的取值范围 min..maxValue，默认 0..2147483647（Postgres integer）
export function intList(x, { max = 50, min = 0, maxValue = 2147483647 } = {}) {
  const parts = Array.isArray(x) ? x : typeof x === "string" ? x.split(",") : typeof x === "number" ? [x] : [];
  const out = [];
  for (const p of parts) {
    if (out.length >= max) break;
    const n = int(p, { min, max: maxValue, fallback: null });
    if (n != null && !out.includes(n)) out.push(n);
  }
  return out;
}

// 严格转数字（可以带小数），不合法返回 fallback
export function float(x, fallback = null) {
  const s = typeof x === "number" ? String(x) : typeof x === "string" ? x.trim() : "";
  return /^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(+s) ? +s : fallback;
}

// 白名单：v 在 allowed 里就返回 v，否则返回 fallback
export function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

// ---------------------------------------------------------------- 启动：数据源、设置、车辆

const SETTINGS_SQL =
  "select unit_of_length, unit_of_temperature, unit_of_pressure, preferred_range, base_url, grafana_url, theme_mode, language from settings limit 1";
// 显示名和 Grafana 的车辆下拉一致：重名时后面加 VIN 后 6 位，没名字时用 VIN。
// since：这辆车最早的一条记录（行程 / 充电 / 位置点），「全部」这类早于接入时间的范围画时间轴时用。
// 位置点只看带续航的：正好走 (car_id, date) 那个部分索引，几千万行的表也是一次索引查找；不带条件的 min(date) 要扫这辆车的全部位置点
const CARS_SQL = `select id, name, model, trim_badging, marketing_name, efficiency, vin, display_priority,
  case when count(id) over (partition by name) > 1 and name is not null then concat(name, ' - ', right(vin, 6))
       else coalesce(name, concat('VIN ', vin)) end as label,
  least(
    (select min(p.date) from positions p where p.car_id = cars.id and p.ideal_battery_range_km is not null),
    (select min(d.start_date) from drives d where d.car_id = cars.id),
    (select min(c.start_date) from charging_processes c where c.car_id = cars.id)
  ) as since
from cars order by display_priority, name, vin`;

function normSettings(r = {}) {
  return {
    lengthUnit: r.unit_of_length === "mi" ? "mi" : "km",
    tempUnit: r.unit_of_temperature === "F" ? "F" : "C",
    pressureUnit: r.unit_of_pressure === "psi" ? "psi" : "bar",
    preferredRange: r.preferred_range === "ideal" ? "ideal" : "rated",
    baseUrl: r.base_url || "",
    grafanaUrl: r.grafana_url || "",
    themeMode: ["light", "dark", "system"].includes(r.theme_mode) ? r.theme_mode : "system",
    language: r.language || "en"
  };
}

function normCar(r) {
  return {
    id: r.id,
    name: r.name || "",
    label: r.label || r.name || "",
    model: r.model || "",
    trim: r.trim_badging || "",
    marketingName: r.marketing_name || "",
    efficiency: r.efficiency,
    vin: r.vin || "",
    displayPriority: r.display_priority,
    // 毫秒；这辆车还没有任何记录时是 null
    since: typeof r.since === "number" && Number.isFinite(r.since) ? r.since : null
  };
}

export async function init() {
  const r = await batch({ settings: SETTINGS_SQL, cars: CARS_SQL }, { cache: false, range: defaultRangeValue() });
  settings = normSettings(r.settings[0]);
  cars = r.cars.map(normCar);
  return { settings, cars };
}

// 各面板共用的 SQL 变量（名字和 Grafana 面板里的一致）
export function commonVars(car, s = settings || normSettings()) {
  return {
    car_id: car ? car.id : 0,
    length_unit: s.lengthUnit,
    temp_unit: s.tempUnit,
    pressure_unit: s.pressureUnit,
    preferred_range: s.preferredRange,
    alternative_length_unit: s.lengthUnit === "mi" ? "ft" : "m",
    speed_unit: s.lengthUnit === "mi" ? "mph" : "km/h",
    base_url: s.baseUrl
  };
}

// Grafana 面板链接（同域 /grafana，不用 settings.grafana_url：那个可能填的是别的地址）。
// 值是数组时逐个 append：Grafana 的多选变量要写成 var-geofence=1&var-geofence=2（拼成 "1,2" 它不认）。
// null / "" 表示不带这个参数（数组里的也跳过）
export function grafanaUrl(uid, params = {}) {
  const q = new URLSearchParams({ orgId: "1" });
  const ok = (v) => v != null && v !== "";
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) {
      q.delete(k);
      for (const x of v) if (ok(x)) q.append(k, String(x));
    } else if (ok(v)) q.set(k, String(v));
  }
  return `${GRAFANA}/d/${encodeURIComponent(uid)}?${q}`;
}

