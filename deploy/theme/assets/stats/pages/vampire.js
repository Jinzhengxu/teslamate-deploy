// 待机掉电（对应 Grafana「Vampire Drain」zhHx2Fggk）：两次用车（行驶 / 充电）之间停着时掉了多少电
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { lenDigits, lenText, endTime } from "./_drive-item.js";

export const title = "待机掉电";
export const range = { default: "90d" };
export const css = true;

// 面板变量 duration：最短停车时长（小时），默认 6
const DURATIONS = ["0", "1", "3", "6", "12", "18", "24"];
const PAGE = 50;
// 手机上是列表，平板和桌面上是表格（和 stats.css 的手机断点一致）
const MOBILE = "(max-width: 768px)";

// 照抄面板：把行程和充电按开始时间排成一串，相邻两次之间（上一次结束 → 这一次开始）就是一次停车。
// 里程表变化 ≥ 1 km 的（中间有没记录到的行驶）、续航反而涨了的都不算。
// 天冷时电池可用电量打折（usable < battery_level），估算的续航损失不准，面板把续航相关的列置空，这里一样。
// 休眠时间：和这次停车有重叠的休眠 / 离线段都算，截到停车的起止（开进地库时就断了网，离线段从行程里就开始了，也算进来）；
// 停车时长直接相减（以前的面板用 age()，停了一个多月时按每月 30 天折算，会算错）。
// SQL 和现在的面板一样，只去掉了面板给链接用的 start_date_ts / end_date_ts 两列、列名去掉了单位后缀
// （range_diff、range_lost_per_hour，单位由页面按设置写），加了最后的 ORDER BY，数字不变
const SQL = `
with merge as (
 SELECT
    c.start_date AS start_date,
    c.end_date AS end_date,
    c.start_ideal_range_km AS start_ideal_range_km,
    c.end_ideal_range_km AS end_ideal_range_km,
    c.start_rated_range_km AS start_rated_range_km,
    c.end_rated_range_km AS end_rated_range_km,
    start_battery_level,
    end_battery_level,
    p.usable_battery_level AS start_usable_battery_level,
    NULL AS end_usable_battery_level,
    p.odometer AS start_km,
    p.odometer AS end_km
 FROM charging_processes c
 JOIN positions p ON c.position_id = p.id
 WHERE c.car_id = $car_id AND $__timeFilter(start_date)
 UNION
 SELECT
    d.start_date AS start_date,
    d.end_date AS end_date,
    d.start_ideal_range_km AS start_ideal_range_km,
    d.end_ideal_range_km AS end_ideal_range_km,
    d.start_rated_range_km AS start_rated_range_km,
    d.end_rated_range_km AS end_rated_range_km,
    start_position.battery_level AS start_battery_level,
    end_position.battery_level AS end_battery_level,
    start_position.usable_battery_level AS start_usable_battery_level,
    end_position.usable_battery_level AS end_usable_battery_level,
    d.start_km AS start_km,
    d.end_km AS end_km
 FROM drives d
 JOIN positions start_position ON d.start_position_id = start_position.id
 JOIN positions end_position ON d.end_position_id = end_position.id
 WHERE d.car_id = $car_id AND $__timeFilter(start_date)
),
v as (
 SELECT
    lag(t.end_date) OVER w AS start_date,
    t.start_date AS end_date,
    lag(t.end_\${preferred_range}_range_km) OVER w AS start_range,
    t.start_\${preferred_range}_range_km AS end_range,
    lag(t.end_km) OVER w AS start_km,
    t.start_km AS end_km,
    EXTRACT(EPOCH FROM (t.start_date - lag(t.end_date) OVER w)) AS duration,
    lag(t.end_battery_level) OVER w AS start_battery_level,
    lag(t.end_usable_battery_level) OVER w AS start_usable_battery_level,
    start_battery_level AS end_battery_level,
    start_usable_battery_level AS end_usable_battery_level,
    start_battery_level > COALESCE(start_usable_battery_level, start_battery_level) AS has_reduced_range
  FROM merge t
  WINDOW w AS (ORDER BY t.start_date ASC)
  ORDER BY start_date DESC
)
SELECT
  v.start_date,
  v.end_date,
  v.duration,
  coalesce(s_standby.sleep, 0) / v.duration AS standby,
  -greatest(v.start_battery_level - v.end_battery_level, 0) AS soc_diff,
  CASE WHEN has_reduced_range THEN 1 ELSE 0 END AS has_reduced_range,
  convert_km(CASE WHEN has_reduced_range THEN NULL ELSE (v.start_range - v.end_range)::numeric END, '$length_unit') AS range_diff,
  CASE WHEN has_reduced_range THEN NULL ELSE (v.start_range - v.end_range) * c.efficiency END AS consumption,
  CASE WHEN has_reduced_range THEN NULL ELSE ((v.start_range - v.end_range) * c.efficiency) / (v.duration / 3600) * 1000 END AS avg_power,
  convert_km(CASE WHEN has_reduced_range THEN NULL ELSE ((v.start_range - v.end_range) / (v.duration / 3600))::numeric END, '$length_unit') AS range_lost_per_hour
FROM v,
  LATERAL (
    SELECT EXTRACT(EPOCH FROM sum(LEAST(s.end_date, v.end_date) - GREATEST(s.start_date, v.start_date))) as sleep
    FROM states s
    WHERE state IN ('asleep', 'offline')
      AND s.start_date < v.end_date
      AND (s.end_date IS NULL OR s.end_date > v.start_date)
      AND s.car_id = $car_id
  ) s_standby
JOIN cars c ON c.id = $car_id
WHERE
  v.duration > ($duration * 60 * 60)
  AND v.start_range - v.end_range >= 0
  AND v.end_km - v.start_km < 1
ORDER BY v.start_date DESC`;

// 休眠占比的颜色档照面板：≥ 85% 绿，30–85% 橙，更低的红
function standbyTone(s) {
  return s >= 0.85 ? "green" : s >= 0.3 ? "amber" : "red";
}

// 休眠占比（v 是 0–1）：会四舍五入成「0%」的写「<1」，会四舍五入成「100%」的写「>99」（没睡满的停车别写成 100%）。
// 不带 %：统计卡片的 % 是单独的小字
function shareNum(v) {
  const p = v * 100;
  return p > 0 && p < 0.5 ? "<1" : p >= 99.5 && p < 100 ? ">99" : fmt.num(p, 0);
}

const shareText = (v) => (v == null ? null : `${shareNum(v)}%`);

export async function render(ctx) {
  const dur = api.oneOf(ctx.query.get("duration"), DURATIONS, "6");
  ctx.setGrafanaVars({ "var-duration": dur });
  ui.render(ctx.root, html`${filterBar(dur)}${ui.skeleton(["stats", "chart", "list"])}`);
  ui.onSegment(ctx.root, "duration", (v) => ctx.setQuery({ duration: v === "6" ? null : v }));

  const d = await api.batch({ rows: { sql: SQL, vars: { duration: +dur } } }, { signal: ctx.signal });
  const rows = d.rows;

  if (!rows.length) {
    const text = dur === "0" ? `${ctx.range.label}没有停车记录。` : `${ctx.range.label}没有超过 ${dur} 小时的停车。`;
    ui.render(
      ctx.root,
      html`${filterBar(dur)}${ui.card(ui.empty(text, { icon: "sleep", title: "没有停车记录", action: emptyAction(ctx, dur) }))}`
    );
    return;
  }

  const s = summarize(rows);
  const L = fmt.unit.len;
  // 天冷的那几次没有续航数，不画点；全是天冷时图就空了，换成一句说明
  const plotted = rows.some((r) => r.range_lost_per_hour != null);
  const perDay = s.rangeHours ? s.kmPerHour * 24 : null;

  ui.render(
    ctx.root,
    html`
      ${filterBar(dur)}
      ${ui.stats(
        [
          { label: "停车次数", icon: "parking", value: rows.length, unit: "次", sub: `累计 ${fmt.duration(s.hours * 60)}` },
          { label: "休眠占比", icon: "sleep", value: s.standby == null ? null : shareNum(s.standby), unit: "%", tone: standbyTone(s.standby), sub: "停着时在休眠或离线" },
          { label: "每天掉续航", icon: "gauge", value: perDay, digits: lenDigits(perDay), unit: L, sub: s.rangeHours ? `约 ${fmt.kwh(s.kwhPerHour * 24, 1)}` : "天冷，续航不可比" },
          // 一天只掉零点几个百分点，取整就成了「0%」，保留一位
          { label: "每天掉电量", icon: "battery-50", value: s.socPerHour == null ? null : s.socPerHour * 24, digits: 1, unit: "%", sub: `共掉了 ${fmt.int(s.soc)}%` },
          // 每小时只掉零点几 km，保留两位才看得出差别
          { label: "每小时掉续航", icon: "gauge", value: s.kmPerHour, digits: 2, unit: L, sub: s.rangeHours ? `共 ${lenText(s.km)}` : "" },
          { label: "平均功率", icon: "lightning-bolt", value: s.rangeHours ? s.kwhPerHour * 1000 : null, unit: "W", sub: s.rangeHours ? `共掉电 ${fmt.kwh(s.kwh, 1)}` : "" }
        ],
        { cols: 3 }
      )}
      ${s.cold
        ? html`<p class="tm-note pg-vd-cold">${ui.icon("snowflake")}<span>有 ${s.cold} 次停车时天冷，电池可用电量打折，估算的续航损失不准，这${s.cold > 1 ? "几" : ""}次的续航、电量（kWh）、功率不显示，也不算进上面的平均；电量 % 照常计算。</span></p>`
        : ""}

      ${ui.section(
        "每次停车折合每天掉的续航",
        ui.card(
          plotted
            ? html`${ui.chartBox("vd-chart", { height: 220, heightMobile: 190, label: "每次停车折合每天掉的续航" })}
                ${ui.legend([
                  { label: "休眠 ≥ 85%", color: "var(--tm-green)" },
                  { label: "30–85%", color: "var(--tm-amber)" },
                  { label: "< 30%", color: "var(--tm-red)" }
                ])}`
            : ui.empty("这几次停车都是天冷的时候，续航损失估不准，画不出来。", { icon: "snowflake" })
        ),
        { sub: `一个点是一次停车，越高掉得越快；颜色是这次停车里休眠的时间占比${s.cold && plotted ? `。天冷的 ${s.cold} 次没画` : ""}` }
      )}

      ${ui.section(`停车记录（${fmt.int(rows.length)}）`, html`<div id="vd-rows"></div>`, { sub: "点一行看那几天车的在线 / 休眠状态" })}
    `
  );

  // 每次加 50 条（「再显示 50 次」只追加新的一段）。手机上画列表，平板和桌面上画表格，
  // 同一时间只有一份 DOM；跨过断点（转屏、拖窗口）时按新的样子从第一页重画
  const box = ctx.root.querySelector("#vd-rows");
  const mq = window.matchMedia(MOBILE);
  const drawRows = () => {
    const asList = mq.matches;
    ui.pager(box, {
      total: rows.length,
      page: PAGE,
      noun: "次停车",
      load: (offset) => {
        const part = rows.slice(offset, offset + PAGE);
        return asList
          ? ui.card(ui.list(part.map((r) => listItem(ctx, r))), { pad: false, attrs: { "data-tm-append": "list" } })
          : ui.card(rowsTable(ctx, part), { pad: false, attrs: { "data-tm-append": "table" } });
      }
    });
  };
  drawRows();
  mq.addEventListener("change", drawRows);
  ctx.onCleanup(() => mq.removeEventListener("change", drawRows));

  if (plotted) await drawChart(ctx, rows);
}

function filterBar(dur) {
  // 它管整页，所以放在最上面、不包卡片
  return ui.segmented("duration", DURATIONS.map((v) => ({ value: v, label: v === "0" ? "不限" : v })), dur, {
    prefix: "只看停车超过",
    suffix: "小时",
    label: "最短停车时长（小时）"
  });
}

// 空状态给一个放宽条件的按钮：先放宽停车时长（保留当前范围），已经不限了再放宽到全部时间
function emptyAction(ctx, dur) {
  if (dur !== "0") return ui.button("不限停车时长", { href: ctx.href("/stats/vampire", { r: ctx.query.get("r"), duration: "0" }), kind: "soft" });
  if (ctx.range.key !== "all") return ui.button("查看全部时间", { href: ctx.href("/stats/vampire", { r: "all", duration: "0" }), kind: "soft" });
  return null;
}

// 汇总：按时长加权。续航、kWh、功率只用没被「天冷」置空的那几次，分母也只算它们的时长；
// 电量 % 和休眠占比所有停车都算
function summarize(rows) {
  const s = { hours: 0, sleepHours: 0, soc: 0, rangeHours: 0, km: 0, kwh: 0, cold: 0 };
  for (const r of rows) {
    const h = r.duration / 3600;
    s.hours += h;
    s.sleepHours += (r.standby || 0) * h;
    s.soc += -(r.soc_diff || 0);
    if (r.range_diff == null) {
      if (r.has_reduced_range) s.cold++;
      continue;
    }
    s.rangeHours += h;
    s.km += r.range_diff;
    s.kwh += r.consumption || 0;
  }
  s.standby = s.hours ? s.sleepHours / s.hours : null;
  s.socPerHour = s.hours ? s.soc / s.hours : null;
  s.kmPerHour = s.rangeHours ? s.km / s.rangeHours : null;
  s.kwhPerHour = s.rangeHours ? s.kwh / s.rangeHours : null;
  return s;
}

// 点进去看那几天的状态时间线（面板是链到 Drive Details 看这段时间的曲线，这里没有对应的页面，状态页最能解释「为什么没睡」）
function statesHref(ctx, r) {
  const ymd = (ms) => fmt.isoDate(ms).replace(/-/g, "");
  return ctx.href("/stats/states", { r: `${ymd(r.start_date)}-${ymd(r.end_date)}` });
}

// 列表标题（列表行的时间段写法）：开始那天不带星期（手机上右边还有数值列）；
// 时间段放不下时从「–」后面折行，不把「次日」拆开
function spanTitle(r) {
  return html`<span class="tm-nowrap">${fmt.shortDay(r.start_date)} ${fmt.time(r.start_date)}–</span><span class="tm-nowrap">${endTime(r.start_date, r.end_date)}</span>`;
}

// 表格、提示框里两头都带日期的时间段：同一天「9月21日 14:05–16:57」，第二天「9月21日 23:06–次日 02:52」，
// 再往后两头都写日期时间、「–」两边加空格（和旅程页的写法一样）。
// 分成「–」和它前面、中间的空格、后面三段：提示框里直接接起来，表格里前后两段各自不折行（periodCell）
function periodParts(a, b) {
  const days = Math.round((new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0)) / 86400e3);
  if (days <= 1) return [`${fmt.dateAuto(a)} ${fmt.time(a)}–`, "", endTime(a, b)];
  // 结束那头同一年不再写年份；跨年时写上，不然「2025年12月30日 20:00 – 1月2日 08:00」像是倒着的
  const endDay = new Date(a).getFullYear() === new Date(b).getFullYear() ? fmt.date(b) : fmt.dateY(b);
  return [`${fmt.dateTime(a)} –`, " ", `${endDay} ${fmt.time(b)}`];
}

const period = (a, b) => periodParts(a, b).join("");

// 表格的时间列：平板上放不下时从「–」后面折成两行（不把日期、「次日」拆开），把宽度让给右边的数值列，
// 免得最后一列要横向滚动才看得到
function periodCell(a, b) {
  const [head, gap, tail] = periodParts(a, b);
  return html`<span class="tm-nowrap">${head}</span>${gap}<span class="tm-nowrap">${tail}</span>`;
}

// 续航损失：按距离的位数，掉了写「−」（减号，不是连字符）。
// 按写出来的数判断：掉了不到 0.05 km 的写成「0.0 km」，不带负号
function lossText(r) {
  if (r.range_diff == null) return null;
  const t = lenText(r.range_diff);
  return t === lenText(0) ? t : `−${t}`;
}

// 电量变化（soc_diff 是 0 或负数）：掉了写「−2%」，没掉写「0%」
function socText(r) {
  return r.soc_diff ? `−${fmt.int(-r.soc_diff)}%` : "0%";
}

function coldPill() {
  return ui.pill("天冷，续航不可比", "cyan", { icon: "snowflake" });
}

function listItem(ctx, r) {
  const cold = r.range_diff == null;
  return {
    href: statesHref(ctx, r),
    icon: "sleep",
    tone: standbyTone(r.standby),
    title: spanTitle(r),
    // 放不下时藏「休眠」：图标的颜色就是休眠占比的档
    sub: ui.fit([`停 ${fmt.duration(r.duration / 60)}`, `休眠 ${shareText(r.standby)}`], { sep: true }),
    // 平均功率和「每小时掉的续航」成正比，放不下时先藏它
    meta: cold ? coldPill() : ui.fit([`每小时 ${fmt.len(r.range_lost_per_hour, 2)}`, fmt.kwh(r.consumption, 1), `${fmt.int(r.avg_power)} W`], { sep: true }),
    value: cold ? socText(r) : lossText(r),
    valueSub: cold ? null : `电量 ${socText(r)}`
  };
}

function rowsTable(ctx, rows) {
  const L = fmt.unit.len;
  return ui.table({
    dense: true,
    rowHref: (r) => statesHref(ctx, r),
    rows,
    columns: [
      { key: "start_date", label: "时间", fmt: (v, r) => periodCell(v, r.end_date), primary: true, wrap: true },
      { key: "duration", label: "时长", align: "right", fmt: (v) => fmt.duration(v / 60) },
      { key: "standby", label: "休眠", align: "right", fmt: (v) => html`<span class="tm-tone-${standbyTone(v)} tm-strong">${shareText(v)}</span>` },
      { key: "soc_diff", label: "电量", align: "right", fmt: (v, r) => socText(r) },
      { key: "range_diff", label: "续航损失", align: "right", fmt: (v, r) => (v == null ? coldPill() : lossText(r)) },
      { key: "consumption", label: "掉电", align: "right", fmt: (v) => (v == null ? "" : fmt.kwh(v, 1)) },
      { key: "avg_power", label: "平均功率", align: "right", fmt: (v) => (v == null ? "" : `${fmt.int(v)} W`) },
      { key: "range_lost_per_hour", label: `每小时（${L}）`, align: "right", fmt: (v) => (v == null ? "" : fmt.num(v, 2)) }
    ]
  });
}

async function drawChart(ctx, rows) {
  // 按时间从早到晚；天冷那几次没有续航数，不画
  const asc = rows.filter((r) => r.range_lost_per_hour != null).reverse();
  const L = fmt.unit.len;
  await chart.create(ctx.root.querySelector("#vd-chart"), {
    xAxis: chart.timeAxis(),
    yAxis: chart.valueAxis({ unit: `${L}/天` }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const r = p && asc[p.dataIndex];
      if (!r) return "";
      const perDay = r.range_lost_per_hour * 24;
      return chart.tipHtml(period(r.start_date, r.end_date), [
        { color: p.color, name: "折合每天", value: lenText(perDay) },
        { name: "停车", value: fmt.duration(r.duration / 60) },
        // 名字已经说了「掉了」，数字不再带负号
        { name: "掉了", value: `${lenText(r.range_diff)} · ${fmt.pct(-r.soc_diff)}` },
        { name: "平均功率", value: `${fmt.int(r.avg_power)} W` },
        { name: "休眠", value: shareText(r.standby) }
      ]);
    }),
    // 每次停车一个点（放在这次停车的中点），颜色按休眠占比。几十上百次停车画成柱子在手机上会挤成条形码
    series: [
      {
        type: "scatter",
        name: "每天掉续航",
        symbolSize: 7,
        data: asc.map((r) => ({
          value: [(r.start_date + r.end_date) / 2, +(r.range_lost_per_hour * 24).toFixed(2)],
          itemStyle: { color: `@${standbyTone(r.standby)}` }
        }))
      }
    ],
    dataZoom: asc.length > 60 ? chart.zoom() : undefined
  });
}
