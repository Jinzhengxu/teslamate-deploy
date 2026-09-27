// 能耗（对应 Grafana「Efficiency」fu4SiQgWz）：净 / 毛能耗、气温与能耗、推算的续航效率
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { lenDigits, lenText } from "./_drive-item.js";

export const title = "能耗";
export const range = { default: "all" };
export const css = true;

// 面板变量 min_distance（只影响「气温与能耗」）：单次行程至少多远才算，单位跟着设置走（km / mi）
const MIN_DISTANCES = ["1", "5", "10", "25", "50"];

// 净能耗：行驶中掉的续航 × 效率 ÷ 距离
const NET_SQL = `
SELECT sum((start_\${preferred_range}_range_km - end_\${preferred_range}_range_km) * cars.efficiency) / convert_km(sum(distance)::numeric, '$length_unit') * 1000 AS consumption
FROM drives
INNER JOIN cars ON cars.id = car_id
WHERE distance IS NOT NULL
  AND start_\${preferred_range}_range_km - end_\${preferred_range}_range_km >= 0.1
  AND $__timeFilter(start_date)
  AND car_id = $car_id`;

// 毛能耗：把行程、充电的起止串成事件流，相邻事件之间掉的续航都算（停车掉电也算进去，充电涨的不算）。
// 照抄面板（它和 Charging Stats / Statistics / Trip 共用）：范围短于 48 小时改用逐个位置点算
const GROSS_SQL = `
with drives_start_event as (
    select 'drive_start' as event, start_date as date, start_\${preferred_range}_range_km as range, start_km as odometer, car_id, distance is null as is_incomplete
    from drives
    where car_id = $car_id and $__timeFilter(start_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
),
drives_end_event as (
    select 'drive_end' as event, case when end_date is null then start_date + interval '1 second' else end_date end as date, end_\${preferred_range}_range_km as range, end_km as odometer, car_id, distance is null as is_incomplete
    from drives
    where car_id = $car_id and $__timeFilter(start_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
),
charging_processes_start_event as (
    select 'charging_process_start' as event, start_date as date, start_\${preferred_range}_range_km as range, p.odometer, cp.car_id, end_date is null as is_incomplete
    from charging_processes cp
        inner join positions p on cp.position_id = p.id
    where cp.car_id = $car_id and $__timeFilter(start_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
),
charging_processes_end_event as (
    select 'charging_process_end' as event, case when end_date is null then start_date + interval '1 second' else end_date end as date, end_\${preferred_range}_range_km as range, p.odometer, cp.car_id, end_date is null as is_incomplete
    from charging_processes cp
        inner join positions p on cp.position_id = p.id
    where cp.car_id = $car_id and $__timeFilter(start_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
),
positions as (
    select
        case when drive_id is not null and lead(drive_id) over w is not null then 'drive_start' else 'something' end as event,
        date, \${preferred_range}_battery_range_km as range, p.odometer, p.car_id, false as is_incomplete
    from positions p
    where ideal_battery_range_km is not null and car_id = $car_id and 48 > ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
    and (drive_id in (select id from drives where $__timeFilter(start_date)) or drive_id is null and $__timeFilter(date))
    window w as (order by date)
),
combined as (
    select * from drives_start_event
    union all select * from drives_end_event
    union all select * from charging_processes_start_event
    union all select * from charging_processes_end_event
    union all select * from positions
),
final as (
    select
        car_id,
        case when is_incomplete then 0 else lead(odometer) over w - odometer end as distance,
        case when is_incomplete then 0 else case when event != 'drive_start' then greatest(range - lead(range) over w, 0) else range - lead(range) over w end end as range_loss
    from combined
    window w as (order by date asc)
)
select
    sum(range_loss) * c.efficiency as energy,
    (sum(range_loss) * c.efficiency * 1000) / nullif(convert_km(sum(distance)::numeric, '$length_unit'), 0) as consumption
from final
    inner join cars c on car_id = c.id
group by c.efficiency`;

const DISTANCE_SQL = `
SELECT convert_km(sum(distance)::numeric, '$length_unit') AS distance, count(distance) AS drives
FROM drives
WHERE car_id = $car_id AND $__timeFilter(start_date)`;

// 按车外平均气温分档：摄氏 5 度一档，华氏 10 度一档。efficiency = 实际距离 ÷ 掉的续航（1 = 跑满额定续航）
const TEMP_SQL = `
WITH t AS (
  SELECT
    CASE WHEN '$temp_unit' = 'C' THEN ROUND(cast(outside_temp_avg AS numeric) / 5, 0) * 5
         WHEN '$temp_unit' = 'F' THEN ROUND(cast(convert_celsius(outside_temp_avg, '$temp_unit') AS numeric) / 10, 0) * 10
    END AS outside_temp,
    sum(start_ideal_range_km - end_ideal_range_km) AS total_ideal_range,
    sum(start_rated_range_km - end_rated_range_km) AS total_rated_range,
    sum(distance) AS total_distance,
    sum(duration_min) AS duration,
    car_id
  FROM drives
  WHERE distance IS NOT NULL
    AND car_id = $car_id
    AND convert_km(distance::numeric, '$length_unit') >= $min_distance
    AND $__timeFilter(start_date)
    AND start_\${preferred_range}_range_km - end_\${preferred_range}_range_km > 0.1
  GROUP BY 1, car_id
)
SELECT
  outside_temp AS temp,
  total_distance / total_\${preferred_range}_range AS efficiency,
  total_\${preferred_range}_range / convert_km(total_distance::numeric, '$length_unit') * c.efficiency * 1000 AS consumption,
  convert_km(total_distance::numeric, '$length_unit') AS distance,
  (convert_km(total_distance::numeric, '$length_unit') / duration) * 60 AS speed
FROM t
JOIN cars c ON t.car_id = c.id
WHERE outside_temp IS NOT NULL
ORDER BY 1 DESC`;

const CURRENT_SQL = `SELECT efficiency / convert_km(1, '$length_unit') * 1000 AS efficiency FROM cars WHERE id = $car_id`;

// 从充电推算的效率：充入电量 ÷ 涨的续航，取出现次数最多的 3 个值。面板里没有时间过滤，这里也不加
const derivedSql = (kind) => `
SELECT round((charge_energy_added / NULLIF(end_${kind}_range_km - start_${kind}_range_km, 0))::numeric / convert_km(1, '$length_unit'), 3) * 1000 AS efficiency,
       count(*) AS count
FROM charging_processes
WHERE car_id = $car_id
  AND duration_min > 10
  AND end_battery_level <= 95
  AND start_${kind}_range_km IS NOT NULL
  AND end_${kind}_range_km IS NOT NULL
  AND charge_energy_added > 0
GROUP BY 1
ORDER BY 2 DESC, 1
LIMIT 3`;

export async function render(ctx) {
  const minDist = api.oneOf(ctx.query.get("min_distance"), MIN_DISTANCES, "1");
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "list"]));

  const d = await api.batch(
    {
      net: NET_SQL,
      gross: GROSS_SQL,
      dist: DISTANCE_SQL,
      temps: { sql: TEMP_SQL, vars: { min_distance: +minDist } },
      current: CURRENT_SQL,
      ideal: derivedSql("ideal"),
      rated: derivedSql("rated")
    },
    { signal: ctx.signal }
  );

  const L = fmt.unit.len;
  const dist = d.dist[0] || {};
  const net = d.net[0] ? d.net[0].consumption : null;
  const gross = d.gross[0] || {};
  const current = d.current[0] ? d.current[0].efficiency : null;
  const rangeName = ctx.settings.preferredRange === "ideal" ? "理想" : "额定";
  const advanced = advancedBlock(d, current, rangeName, ctx.settings.preferredRange === "ideal" ? d.ideal : d.rated);

  if (!dist.drives) {
    ui.render(
      ctx.root,
      html`${ui.card(ui.empty(`${ctx.range.label}没有行程，算不出能耗。`, { icon: "leaf", title: "没有行程", action: allButton(ctx) }))}
        ${advanced}`
    );
    return;
  }

  const temps = d.temps;
  ui.render(
    ctx.root,
    html`
      ${ui.stats(
        [
          { label: "能耗（净）", icon: "leaf", value: net, unit: fmt.unit.cons, sub: "只算行驶中的耗电" },
          {
            label: "能耗（毛）",
            icon: "leaf",
            value: gross.consumption,
            unit: fmt.unit.cons,
            sub: gross.energy == null ? "含停车掉电" : ui.segs(["含停车掉电", fmt.kwh(gross.energy, 1)])
          },
          { label: "统计里程", icon: "road-variant", value: dist.distance, digits: lenDigits(dist.distance), unit: L, sub: `${fmt.int(dist.drives)} 次行程` },
          { label: `当前${rangeName}效率`, icon: "leaf", value: current, unit: fmt.unit.cons, sub: `每 ${L} ${rangeName}续航的电量` }
        ],
        { cols: 4 }
      )}

      ${ui.section(
        "气温与能耗",
        ui.card(
          html`<div class="pg-eff-top">
              ${ui.segmented("min_distance", MIN_DISTANCES, minDist, { prefix: "只算单次超过", suffix: L, label: `最短行程距离（${L}）` })}
              ${temps.length
                ? html`${ui.chartBox("eff-temp", { height: 250, heightMobile: 210, label: "各气温档的平均能耗" })}
                    ${current != null
                      ? html`<p class="tm-note pg-eff-ref"><i></i>虚线是当前${rangeName}效率 ${fmt.cons(current)}，柱子比它矮说明这个气温下比${rangeName}续航还省。</p>`
                      : ""}`
                : ui.empty(`没有超过 ${minDist} ${L} 且记录了气温的行程。`, { icon: "thermometer" })}
            </div>
            ${temps.length ? tempTable(temps) : ""}`,
          { pad: false, cls: "pg-eff-card" }
        ),
        { sub: `按行程的平均车外气温分档；效率 100% 表示跑满了${rangeName}续航` }
      )}

      ${advanced}
    `
  );

  ui.onSegment(ctx.root, "min_distance", (v) => ctx.setQuery({ min_distance: v === "1" ? null : v }));

  if (temps.length) await drawTemps(ctx, temps, current);
}

function allButton(ctx) {
  if (ctx.range.key === "all") return null;
  return ui.button("查看全部时间", { href: ctx.href("/stats/efficiency", { r: "all" }), kind: "soft" });
}

// ---------------------------------------------------------------- 气温与能耗

// 驾驶效率的颜色档照面板：≥ 99% 绿，65%~99% 橙，更低的红
function effTone(e) {
  return e >= 0.99 ? "green" : e >= 0.65 ? "amber" : "red";
}

// 手机上也是表格（11 行左右，变成卡片会有两屏长）。表头第二行小字是单位
function tempTable(rows) {
  const head = (text, unit) => html`${text}<small>${unit}</small>`;
  return ui.table({
    mobile: "table",
    rows,
    columns: [
      { key: "temp", label: "气温", primary: true, fmt: (v) => fmt.temp(v, 0) },
      {
        key: "efficiency",
        label: "驾驶效率",
        fmt: (v) => html`<div class="pg-eff-bar">${ui.bar(v, 1.15, effTone(v))}<span class="tm-num tm-tone-${effTone(v)}">${fmt.pct(v * 100, 1)}</span></div>`
      },
      { key: "consumption", label: head("能耗", fmt.unit.cons), align: "right", fmt: (v) => html`<span class="tm-strong">${fmt.int(v)}</span>` },
      { key: "distance", label: head("里程", fmt.unit.len), align: "right", fmt: (v) => fmt.num(v, lenDigits(v)) },
      { key: "speed", label: head("均速", fmt.unit.speed), align: "right", fmt: (v) => fmt.int(v) }
    ]
  });
}

async function drawTemps(ctx, rows, current) {
  // 图上从冷到热排（表格照面板从热到冷）
  const asc = [...rows].sort((a, b) => a.temp - b.temp);
  // 柱子统一一个颜色：好坏看参考虚线就够了，表格里再按面板的阈值上色
  const series = chart.bars("能耗", asc.map((r) => +r.consumption.toFixed(1)), { color: "c1", width: 26 });
  if (current != null) {
    // 参考线（当前额定效率）。说明文字放在图下面：线上的标签两头都会压到最高的柱子
    series.markLine = {
      silent: true,
      symbol: "none",
      lineStyle: { color: "@text-2", type: "dashed", width: 1.5 },
      label: { show: false },
      data: [{ yAxis: current }]
    };
  }
  await chart.create(ctx.root.querySelector("#eff-temp"), {
    xAxis: chart.categoryAxis(asc.map((r) => fmt.temp(r.temp, 0))),
    yAxis: chart.valueAxis({ unit: fmt.unit.cons }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const r = p && asc[p.dataIndex];
      if (!r) return "";
      return chart.tipHtml(`${fmt.temp(r.temp, 0)} 左右`, [
        { color: p.color, name: "平均能耗", value: fmt.cons(r.consumption) },
        { name: "驾驶效率", value: fmt.pct(r.efficiency * 100, 1) },
        { name: "里程", value: lenText(r.distance) },
        { name: "平均速度", value: fmt.speed(r.speed) }
      ]);
    }),
    series: [series]
  });
}

// ---------------------------------------------------------------- 进阶：从充电推算的效率

function advancedBlock(d, current, rangeName, preferred) {
  const L = fmt.unit.len;
  // 面板只列数字，由人自己对照。这里按首选续航那一栏的第一名判断，一致 / 不一致说法不同，别不管数据都说「一致」
  const top = preferred[0];
  const same = top && current != null ? Math.round(top.efficiency) === Math.round(current) : null;
  const verdict =
    same == null
      ? ""
      : same
        ? html`次数最多的那个和上面的「当前${rangeName}效率」（${fmt.cons(current)}）一致，说明这台车的效率参数是对的。`
        : html`按${rangeName}续航推算，次数最多的是 ${fmt.cons(top.efficiency)}，和上面的「当前${rangeName}效率」（${fmt.cons(current)}）不一样（充电次数还少时常见）。差得多的话，按效率换算出来的能耗、耗电也会跟着偏。`;
  const block = (title, rows) =>
    html`<div class="pg-eff-derived">
      <h3 class="tm-card-title">${title}</h3>
      ${rows.length
        ? ui.kv(
            rows.map((r) => [
              html`<span class="tm-num">${fmt.cons(r.efficiency)}</span>${current != null && Math.round(r.efficiency) === Math.round(current) ? html` ${ui.pill("当前", "accent")}` : ""}`,
              `${fmt.int(r.count)} 次充电`
            ])
          )
        : html`<p class="tm-note">没有符合条件的充电。</p>`}
    </div>`;
  return ui.details(
    "进阶：从充电推算的效率",
    html`<p class="tm-note">TeslaMate 用每次充电「充入电量 ÷ 涨的续航」推算 1 ${L} 续航对应多少电（只看 10 分钟以上、充到 95% 以下的充电，不分时间范围），下面是出现次数最多的三个值。
        ${verdict}</p>
      <div class="tm-grid-2">
        ${block("按理想续航推算", d.ideal)}
        ${block("按额定续航推算", d.rated)}
      </div>`
  );
}
