// 待机掉电（对应 Grafana「Vampire Drain」zhHx2Fggk）：两次用车（行驶 / 充电）之间停着时掉了多少电
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";

export const title = "待机掉电";
export const range = { default: "90d" };
export const css = true;

// 面板变量 duration：最短停车时长（小时），默认 6
const DURATIONS = ["0", "1", "3", "6", "12", "18", "24"];
const PAGE = 50;

// 照抄面板：把行程和充电按开始时间排成一串，相邻两次之间（上一次结束 → 这一次开始）就是一次停车。
// 里程表变化 ≥ 1 km 的（中间有没记录到的行驶）、续航反而涨了的都不算。
// 天冷时电池可用电量打折（usable < battery_level），估算的续航损失不准，面板把续航相关的列置空，这里一样。
// 只加了最后的 ORDER BY，数字不变
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
    EXTRACT(EPOCH FROM age(t.start_date, lag(t.end_date) OVER w)) AS duration,
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
  (coalesce(s_asleep.sleep, 0) + coalesce(s_offline.sleep, 0)) / v.duration AS standby,
  -greatest(v.start_battery_level - v.end_battery_level, 0) AS soc_diff,
  CASE WHEN has_reduced_range THEN 1 ELSE 0 END AS has_reduced_range,
  convert_km(CASE WHEN has_reduced_range THEN NULL ELSE (v.start_range - v.end_range)::numeric END, '$length_unit') AS range_diff,
  CASE WHEN has_reduced_range THEN NULL ELSE (v.start_range - v.end_range) * c.efficiency END AS consumption,
  CASE WHEN has_reduced_range THEN NULL ELSE ((v.start_range - v.end_range) * c.efficiency) / (v.duration / 3600) * 1000 END AS avg_power,
  convert_km(CASE WHEN has_reduced_range THEN NULL ELSE ((v.start_range - v.end_range) / (v.duration / 3600))::numeric END, '$length_unit') AS range_lost_per_hour
FROM v,
  LATERAL (
    SELECT EXTRACT(EPOCH FROM sum(age(s.end_date, s.start_date))) as sleep
    FROM states s
    WHERE state = 'asleep' AND v.start_date <= s.start_date AND s.end_date <= v.end_date AND s.car_id = $car_id
  ) s_asleep,
  LATERAL (
    SELECT EXTRACT(EPOCH FROM sum(age(s.end_date, s.start_date))) as sleep
    FROM states s
    WHERE state = 'offline' AND v.start_date <= s.start_date AND s.end_date <= v.end_date AND s.car_id = $car_id
  ) s_offline
JOIN cars c ON c.id = $car_id
WHERE
  v.duration > ($duration * 60 * 60)
  AND v.start_range - v.end_range >= 0
  AND v.end_km - v.start_km < 1
ORDER BY v.start_date DESC`;

// 休眠占比的颜色档照面板：≥ 85% 绿，30%~85% 橙，更低的红
function standbyTone(s) {
  return s >= 0.85 ? "green" : s >= 0.3 ? "amber" : "red";
}

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
      html`${filterBar(dur)}${ui.card(ui.empty(text, { icon: "sleep", title: "没有数据", action: emptyAction(ctx, dur) }))}`
    );
    return;
  }

  const s = summarize(rows);
  const L = fmt.unit.len;
  // 天冷的那几次没有续航数，不画点；全是天冷时图就空了，换成一句说明
  const plotted = rows.some((r) => r.range_lost_per_hour != null);

  ui.render(
    ctx.root,
    html`
      ${filterBar(dur)}
      <div class="pg-vd-stats">${ui.stats(
        [
          { label: "停车次数", value: rows.length, unit: "次", sub: `累计 ${fmt.duration(s.hours * 60)}` },
          { label: "休眠占比", value: fmt.num(s.standby * 100, 0), unit: "%", tone: standbyTone(s.standby), sub: "停着时在休眠或离线" },
          { label: "每天掉续航", value: s.rangeHours ? fmt.num(s.kmPerHour * 24, 1) : null, unit: L, sub: s.rangeHours ? `约 ${fmt.kwh(s.kwhPerHour * 24, 2)}` : "天冷，续航不可比" },
          { label: "每天掉电量", value: fmt.num(s.socPerHour * 24, 1), unit: "%", sub: `共掉了 ${fmt.int(s.soc)}%` },
          { label: "每小时掉续航", value: s.rangeHours ? fmt.num(s.kmPerHour, 2) : null, unit: L, sub: s.rangeHours ? `共 ${fmt.len(s.km, 1)}` : "" },
          { label: "平均功率", value: s.rangeHours ? fmt.num(s.kwhPerHour * 1000, 0) : null, unit: "W", sub: s.rangeHours ? `共掉电 ${fmt.kwh(s.kwh, 1)}` : "" }
        ],
        { cols: 3 }
      )}</div>
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
                  { label: "30% ~ 85%", color: "var(--tm-amber)" },
                  { label: "< 30%", color: "var(--tm-red)" }
                ])}`
            : ui.empty("这几次停车都是天冷的时候，续航损失估不准，画不出来。", { icon: "snowflake" })
        ),
        { sub: `一个点是一次停车，越高掉得越快；颜色是这次停车里休眠的时间占比${s.cold && plotted ? `。天冷的 ${s.cold} 次没画` : ""}` }
      )}

      ${ui.section(`停车记录（${fmt.int(rows.length)}）`, html`<div id="vd-rows" class="pg-vd-rows"></div>`, { sub: "点一行看那几天车的在线 / 休眠状态" })}
    `
  );

  // 分批渲染：先 50 条，「再显示」每次加 50 条（按钮文字和行程、充电列表一样）
  let shown = 0;
  const box = ctx.root.querySelector("#vd-rows");
  const more = () => {
    const before = shown;
    shown = Math.min(rows.length, shown + PAGE);
    const part = rows.slice(0, shown);
    const rest = rows.length - shown;
    ui.render(
      box,
      html`${ui.card(ui.list(part.map((r) => listItem(ctx, r))), { pad: false, cls: "tm-only-mobile" })}
        ${ui.card(rowsTable(ctx, part), { pad: false, cls: "tm-hide-mobile" })}
        ${rest > 0
          ? html`<div class="pg-vd-more">${ui.button(`再显示 ${fmt.int(Math.min(PAGE, rest))} 次`, { kind: "soft", attrs: { "data-vd-more": "" } })}<span class="tm-note">还有 ${fmt.int(rest)} 次停车</span></div>`
          : rows.length > PAGE
            ? html`<p class="tm-note pg-vd-end">共 ${fmt.int(rows.length)} 次停车，已全部显示</p>`
            : ""}`
    );
    return before;
  };
  box.addEventListener("click", (e) => {
    if (!e.target.closest("[data-vd-more]")) return;
    const before = more();
    // 整块重画后按钮没了，焦点会掉回 body：移到新加的第一行（手机列表或桌面表格里看得见的那个）
    const links = [...box.querySelectorAll(".tm-only-mobile a.tm-row, .tm-hide-mobile tbody a")].filter((a) => a.offsetParent);
    if (links[before]) links[before].focus({ preventScroll: true });
  });
  more();

  if (plotted) await drawChart(ctx, rows);
}

function filterBar(dur) {
  return html`<div class="pg-vd-filter">
    <span class="tm-small tm-muted">只看停车超过</span>
    <span class="pg-vd-filter-seg">
      ${ui.segmented("duration", DURATIONS.map((v) => ({ value: v, label: v === "0" ? "不限" : v })), dur, { label: "最短停车时长（小时）" })}
      <span class="tm-small tm-muted">小时</span>
    </span>
  </div>`;
}

// 空状态给一个放宽条件的按钮：先放宽停车时长（保留当前范围），已经不限了再放宽到全部时间
function emptyAction(ctx, dur) {
  if (dur !== "0") return ui.button("不限停车时长", { href: ctx.href("/stats/vampire", { r: ctx.query.get("r"), duration: "0" }), kind: "soft" });
  if (ctx.range.key !== "all") return ui.button("看全部时间", { href: ctx.href("/stats/vampire", { r: "all", duration: "0" }), kind: "soft", icon: "calendar-range" });
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
  const ymd = (ms) => {
    const dt = new Date(ms);
    return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
  };
  return ctx.href("/stats/states", { r: `${ymd(r.start_date)}-${ymd(r.end_date)}` });
}

// 续航损失照面板保留两位小数（一次停车常常只掉 2~3 km，一位小数看不出差别）
function lossText(r) {
  return r.range_diff == null ? null : r.range_diff > 0 ? `-${fmt.len(r.range_diff, 2)}` : fmt.len(0, 2);
}

function socText(r) {
  return r.soc_diff ? `${fmt.int(r.soc_diff)}%` : "0%";
}

function coldPill() {
  return ui.pill("天冷，续航不可比", "cyan", { icon: "snowflake" });
}

// 列表标题不带星期：手机上右边还有数值列，320 宽时带星期会把时间挤成省略号（桌面表格里是完整日期）
function dayShort(ms) {
  const d = fmt.day(ms);
  return d === "今天" || d === "昨天" ? d : fmt.dateAuto(ms);
}

function listItem(ctx, r) {
  const cold = r.range_diff == null;
  return {
    href: statesHref(ctx, r),
    icon: "sleep",
    tone: standbyTone(r.standby),
    title: `${dayShort(r.start_date)} ${fmt.time(r.start_date)}`,
    sub: html`<span class="pg-vd-nb">停 ${fmt.duration(r.duration / 60)}</span> · <span class="pg-vd-nb">休眠 ${fmt.pct(r.standby * 100)}</span>`,
    meta: cold
      ? coldPill()
      : // 平均功率和「每小时掉的续航」成正比，手机上省掉它保持三行（桌面表格里有）
        html`<span class="tm-small tm-muted tm-num">每小时 ${fmt.len(r.range_lost_per_hour, 2)} · ${fmt.kwh(r.consumption, 2)}</span>`,
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
      { key: "start_date", label: "开始", fmt: (v) => fmt.dateTime(v), primary: true },
      { key: "end_date", label: "结束", fmt: (v) => fmt.dateTime(v) },
      { key: "duration", label: "时长", align: "right", fmt: (v) => fmt.duration(v / 60) },
      { key: "standby", label: "休眠", align: "right", fmt: (v) => html`<span class="tm-tone-${standbyTone(v)} tm-strong">${fmt.pct(v * 100)}</span>` },
      { key: "soc_diff", label: "电量", align: "right", fmt: (v, r) => socText(r) },
      { key: "range_diff", label: `续航损失`, align: "right", fmt: (v, r) => (v == null ? coldPill() : lossText(r)) },
      { key: "consumption", label: "掉电", align: "right", fmt: (v) => (v == null ? "" : fmt.kwh(v, 2)) },
      { key: "avg_power", label: "平均功率", align: "right", fmt: (v) => (v == null ? "" : `${fmt.num(v, 1)} W`) },
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
      return chart.tipHtml(`${fmt.dateTime(r.start_date)} 起`, [
        { color: p.color, name: "折合每天", value: fmt.len(r.range_lost_per_hour * 24, 1) },
        { name: "停车", value: fmt.duration(r.duration / 60) },
        { name: "掉了", value: `${fmt.len(r.range_diff, 2)} · ${socText(r)}` },
        { name: "平均功率", value: `${fmt.num(r.avg_power, 0)} W` },
        { name: "休眠", value: fmt.pct(r.standby * 100) }
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
    // 时间轴最右边的日期标签会被裁掉一半，多留点边
    grid: { right: 22 },
    dataZoom: asc.length > 60 ? chart.zoom() : undefined
  });
}
