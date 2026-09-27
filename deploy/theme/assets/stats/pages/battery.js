// 电池健康（对应 Grafana 面板 Battery Health，jchmRiqUfXgTM）
//
// 面板的 SQL 都不看时间范围（全部历史），所以这页不用范围选择器。
// 面板先用隐藏变量 aux 跑一次大查询（效率、当前 / 新车容量、当前 / 新车满电续航），别的格子再从 aux 的 JSON 里取值，
// 在 Grafana 里是两轮查询。这里把 aux 拆成同样的 CTE，嵌进每条要用它的 SQL，一次 batch 取齐。
// 面板上的 custom_kwh_new / custom_max_range 按规格用默认 0（自动推算），所以 CASE WHEN … > 0 那一支都去掉了。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";

export const title = "电池健康";
export const range = null;
export const css = true;

// 面板变量 aux 的前半段：TeslaMate 按充电推算的额定能耗（kWh / 100 km）。
// 取「充电 10 分钟以上、充到 95% 以下」的充电里出现最多的那个推算值，没有就用车型自带的效率。
const AUX_CTE = `Aux AS (
  SELECT car_id, COALESCE(derived_efficiency, car_efficiency) AS efficiency
  FROM (
    SELECT
      ROUND((charge_energy_added / NULLIF(end_rated_range_km - start_rated_range_km, 0))::numeric, 3) * 100 AS derived_efficiency,
      COUNT(*) AS count,
      cars.id AS car_id,
      cars.efficiency * 100 AS car_efficiency
    FROM cars
      LEFT JOIN charging_processes ON
        cars.id = charging_processes.car_id
        AND duration_min > 10
        AND end_battery_level <= 95
        AND start_rated_range_km IS NOT NULL
        AND end_rated_range_km IS NOT NULL
        AND charge_energy_added > 0
    WHERE cars.id = $car_id
    GROUP BY 1, 3, 4
    ORDER BY 2 DESC
    LIMIT 1
  ) AS Efficiency
)`;

// aux 的其余部分 + 各个统计格子，合成一行。和面板一样：
//   CurrentCapacity 最近 100 条充电记录推算的容量取平均；MaxCapacity 每次充电最后一条记录推算的容量取最大；
//   CurrentRange 最近一条（位置或充电）记录的续航 ÷ 可用电量；MaxRange 按天汇总的续航 ÷ 电量取最大。
// 面板在 CurrentCapacity 为空时显示 1（「看到 1.0 kWh 说明还没有长时间的充电」），这里保留 NULL，页面上直接说明。
const STATS_SQL = `WITH ${AUX_CTE},
CurrentCapacity AS (
  SELECT AVG(Capacity) AS Capacity
  FROM (
    SELECT c.rated_battery_range_km * aux.efficiency / c.usable_battery_level AS Capacity
    FROM charging_processes cp
      INNER JOIN charges c ON c.charging_process_id = cp.id
      INNER JOIN aux ON cp.car_id = aux.car_id
    WHERE cp.car_id = $car_id
      AND cp.end_date IS NOT NULL
      AND cp.charge_energy_added >= aux.efficiency
      AND c.usable_battery_level > 0
    ORDER BY cp.end_date DESC, c.date DESC
    LIMIT 100
  ) AS lastCharges
),
MaxCapacity AS (
  SELECT MAX(c.rated_battery_range_km * aux.efficiency / c.usable_battery_level) AS Capacity
  FROM charging_processes cp
    INNER JOIN (
      SELECT charging_process_id, MAX(date) AS date FROM charges WHERE usable_battery_level > 0 GROUP BY charging_process_id
    ) AS gcharges ON cp.id = gcharges.charging_process_id
    INNER JOIN charges c ON c.charging_process_id = cp.id AND c.date = gcharges.date
    INNER JOIN aux ON cp.car_id = aux.car_id
  WHERE cp.car_id = $car_id
    AND cp.end_date IS NOT NULL
    AND cp.charge_energy_added >= aux.efficiency
),
CurrentRange AS (
  SELECT (range * 100.0 / usable_battery_level) AS range
  FROM (
    (
      SELECT date, \${preferred_range}_battery_range_km AS range, usable_battery_level
      FROM positions
      WHERE car_id = $car_id AND ideal_battery_range_km IS NOT NULL AND usable_battery_level > 0
      ORDER BY date DESC
      LIMIT 1
    )
    UNION ALL
    (
      SELECT date, \${preferred_range}_battery_range_km AS range, usable_battery_level
      FROM charges c
        INNER JOIN charging_processes p ON p.id = c.charging_process_id
      WHERE p.car_id = $car_id AND usable_battery_level > 0
      ORDER BY date DESC
      LIMIT 1
    )
  ) AS data
  ORDER BY date DESC
  LIMIT 1
),
MaxRange AS (
  SELECT
    floor(extract(epoch from date) / 86400) * 86400 AS time,
    CASE
      WHEN sum(usable_battery_level) = 0 THEN sum(\${preferred_range}_battery_range_km) * 100
      ELSE sum(\${preferred_range}_battery_range_km) / sum(usable_battery_level) * 100
    END AS range
  FROM (
    SELECT battery_level, usable_battery_level, date, \${preferred_range}_battery_range_km
    FROM charges c
      INNER JOIN charging_processes p ON p.id = c.charging_process_id
    WHERE p.car_id = $car_id AND usable_battery_level IS NOT NULL
  ) AS data
  GROUP BY 1
  ORDER BY 2 DESC
  LIMIT 1
),
Drv AS (
  -- 面板 Drive Stats：先各自取整再相减，「未记录」才和面板一模一样
  SELECT
    ROUND(convert_km(sum(distance)::numeric, '$length_unit'), 0) AS logged,
    ROUND(convert_km((max(end_km) - min(start_km))::numeric, '$length_unit'), 0) AS mileage,
    ROUND(convert_km(max(end_km)::numeric, '$length_unit'), 0) AS odometer
  FROM drives
  WHERE car_id = $car_id
),
Chg AS (
  SELECT
    COUNT(*) AS n,
    SUM(charge_energy_added) AS added,
    SUM(greatest(charge_energy_added, charge_energy_used)) AS used
  FROM charging_processes
  WHERE car_id = $car_id AND charge_energy_added > 0.01
),
Soc AS (
  SELECT * FROM (
    (
      SELECT usable_battery_level, date
      FROM positions
      WHERE car_id = $car_id AND ideal_battery_range_km IS NOT NULL AND usable_battery_level IS NOT NULL
      ORDER BY date DESC
      LIMIT 1
    )
    UNION ALL
    (
      SELECT c.usable_battery_level, date
      FROM charges c
        JOIN charging_processes p ON p.id = c.charging_process_id
      WHERE p.car_id = $car_id AND c.usable_battery_level IS NOT NULL
      ORDER BY date DESC
      LIMIT 1
    )
  ) AS last_usable_battery_level
  ORDER BY date DESC
  LIMIT 1
)
SELECT
  convert_km(MaxRange.range, '$length_unit') AS max_range,
  convert_km(CurrentRange.range, '$length_unit') AS current_range,
  MaxCapacity.Capacity::float AS max_capacity,
  CurrentCapacity.Capacity::float AS current_capacity,
  Aux.efficiency::float AS rated_efficiency,
  Aux.efficiency::float * 10 / convert_km(1, '$length_unit') AS efficiency,
  Drv.logged, Drv.mileage, Drv.odometer,
  Chg.n AS charges, Chg.added, Chg.used,
  Soc.usable_battery_level AS soc, Soc.date AS soc_date
FROM (SELECT NULL) AS Base
  LEFT JOIN MaxRange ON true
  LEFT JOIN CurrentRange ON true
  LEFT JOIN Aux ON true
  LEFT JOIN MaxCapacity ON true
  LEFT JOIN CurrentCapacity ON true
  LEFT JOIN Drv ON true
  LEFT JOIN Chg ON true
  LEFT JOIN Soc ON true`;

// 面板 AC/DC - Energy Used：每次充电按记录里最常见的相数分交流 / 直流（相数为空或 0 算直流），从电网取的电量
const ACDC_SQL = `WITH data AS (
  SELECT
    cp.id,
    cp.charge_energy_added,
    CASE WHEN NULLIF(mode() within group (order by charger_phases), 0) is null THEN 'DC' ELSE 'AC' END AS current,
    cp.charge_energy_used
  FROM charging_processes cp
    RIGHT JOIN charges ON cp.id = charges.charging_process_id
  WHERE cp.car_id = $car_id AND cp.charge_energy_added > 0.01
  GROUP BY 1, 2
)
SELECT current AS metric, SUM(GREATEST(charge_energy_added, charge_energy_used)) AS value
FROM data
GROUP BY 1
ORDER BY 1 DESC`;

// 面板 Battery Capacity by Mileage 的两条查询。每次充电取最后一条记录推算容量：
//   points：按（本地）日期汇总，每天一个点；median：按半个月取中位数，画成趋势线。
// 这里的续航固定用 rated（面板就是这样，和 preferred_range 无关）
const CAP_FROM = `FROM charging_processes cp
    JOIN (SELECT charging_process_id, MAX(date) AS date FROM charges WHERE usable_battery_level > 0 GROUP BY charging_process_id) AS last_charges
      ON cp.id = last_charges.charging_process_id
    INNER JOIN charges c ON c.charging_process_id = cp.id AND c.date = last_charges.date
    INNER JOIN positions p ON p.id = cp.position_id
    CROSS JOIN Aux
  WHERE cp.car_id = $car_id
    AND cp.end_date IS NOT NULL
    AND cp.charge_energy_added >= Aux.efficiency::float`;

const POINTS_SQL = `WITH ${AUX_CTE}
SELECT
  convert_km(AVG(p.odometer)::numeric, '$length_unit') AS odometer,
  AVG(c.rated_battery_range_km * Aux.efficiency::float / c.usable_battery_level) AS kwh,
  to_char(timezone('$__timezone', timezone('UTC', cp.end_date)), 'YYYY-MM-DD') AS day
  ${CAP_FROM}
GROUP BY 3
ORDER BY 3`;

const MEDIAN_SQL = `WITH ${AUX_CTE}
SELECT
  ROUND(MIN(convert_km(p.odometer::numeric, '$length_unit')), 0) AS odometer,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.rated_battery_range_km * Aux.efficiency::float / c.usable_battery_level)::numeric, 1) AS kwh,
  to_char(timezone('$__timezone', timezone('UTC', cp.end_date)), 'YYYYMM')
    || CASE WHEN to_char(timezone('$__timezone', timezone('UTC', cp.end_date)), 'DD')::int <= 15 THEN '1' ELSE '2' END AS title
  ${CAP_FROM}
GROUP BY 3
ORDER BY 3`;

// 面板阈值：衰减 <10% 绿、10~20% 黄、≥20% 红（健康度 ≥90 绿、80~90 黄、<80 红，是同一回事）
function healthTone(deg) {
  if (deg == null) return "muted";
  return deg < 10 ? "green" : deg < 20 ? "amber" : "red";
}

// 电量合计一位小数；上万度（开了几年）时 320 宽的宫格放不下「12,345.6 kWh」，只有这时取整
const kwhDigits = (v) => (v >= 10000 ? 0 : 1);

export async function render(ctx) {
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "stats"]));

  const d = await api.batch(
    { stats: STATS_SQL, acdc: ACDC_SQL, points: POINTS_SQL, median: MEDIAN_SQL },
    { signal: ctx.signal }
  );

  const s = d.stats[0] || {};
  const noData = !s.charges && s.odometer == null && s.soc == null;
  if (noData) {
    ui.render(
      ctx.root,
      ui.card(ui.empty("这辆车还没有行程和充电记录，开几次、充几次电之后再来看。", { icon: "battery-heart-variant", title: "没有行程和充电" }))
    );
    return;
  }

  const cap = s.current_capacity;
  const capNew = s.max_capacity;
  const hasCap = cap != null && capNew != null && capNew > 0;
  // 面板：衰减 = max(0, 100 − 当前 ÷ 新车 × 100)，健康度 = min(100, 100 − 衰减)
  const deg = hasCap ? Math.max(0, 100 - (cap * 100) / capNew) : null;
  const health = deg == null ? null : Math.min(100, 100 - deg);
  const tone = healthTone(deg);
  // 括号里的差值用显示出来的两个数相减（容量一位小数、续航取整），和旁边的数自己减一下对得上
  const capDiff = hasCap ? fmt.roundDiff(cap, capNew, 1) : null;
  const rangeDiff = fmt.roundDiff(s.current_range, s.max_range);
  const cycles = s.added != null && capNew > 0 ? Math.floor(s.added / capNew) : null;
  const stored = s.soc != null && cap != null ? (s.soc * cap) / 100 : null;
  const chargeEff = s.used > 0 ? s.added / s.used : null;
  const dataLost = s.mileage != null && s.logged != null ? s.mileage - s.logged : null;

  const acdc = { AC: 0, DC: 0 };
  for (const r of d.acdc) if (r.metric in acdc) acdc[r.metric] = r.value || 0;
  const acdcTotal = acdc.AC + acdc.DC;

  const hero = html`<div class="tm-card is-pad pg-battery-hero">
    <div class="pg-battery-block">
      <div class="tm-between">
        <span class="pg-battery-label">电池健康</span>
        ${ui.pill("估算值", "muted")}
      </div>
      <div class="pg-battery-big">
        <span class="pg-battery-num">${health == null ? "—" : html`${fmt.num(health, 1)}<small>%</small>`}</span>
        ${deg != null ? html`<span class="pg-battery-deg tm-tone-${tone}">衰减 ${fmt.pct(deg, 1)}</span>` : ""}
      </div>
      ${health != null ? ui.bar(health, 100, tone) : ""}
      <p class="tm-note">
        ${hasCap
          ? "衰减是按满电续航推算的估计值（充电时的续航 × 能耗 ÷ 电量），只作参考；记录越早、越完整越准。"
          : `还没有足够长的充电记录，估算不了电池容量。至少要有一次充入 ${fmt.num(s.rated_efficiency ?? 15, 0)} kWh 以上并且已经结束的充电。`}
      </p>
    </div>
    <div class="pg-battery-block">
      <div class="tm-between">
        <span class="pg-battery-label">当前电量</span>
        ${s.soc_date ? html`<span class="tm-note">${fmt.rel(s.soc_date)}</span>` : ""}
      </div>
      <div class="pg-battery-big">
        <span class="pg-battery-num is-sm">${s.soc == null ? "—" : html`${fmt.num(s.soc, 0)}<small>%</small>`}</span>
        ${stored != null ? html`<span class="pg-battery-deg">约 ${fmt.kwh(stored, 1)}</span>` : ""}
      </div>
      ${ui.bar(s.soc ?? 0, 100)}
      <p class="tm-note">按可用电量算，天冷时比车上显示的略低。</p>
    </div>
  </div>`;

  const keyStats = ui.stats(
    [
      {
        label: "可用容量",
        icon: "car-battery",
        value: cap,
        digits: 1,
        unit: "kWh",
        sub: capNew != null ? `新车 ${fmt.num(capNew, 1)}${capDiff != null ? `（${fmt.signed(capDiff, 1)}）` : ""}` : "充电记录不够"
      },
      {
        label: "满电续航",
        icon: "gauge",
        value: s.current_range,
        unit: fmt.unit.len,
        sub:
          s.max_range != null
            ? `新车 ${fmt.num(s.max_range, 0)}${rangeDiff != null ? `（${fmt.signed(rangeDiff, 0)}）` : ""}`
            : null
      },
      {
        label: "充电循环",
        icon: "refresh",
        value: cycles,
        unit: "次",
        sub: s.added != null ? `充入 ${fmt.kwh(s.added, 1)}` : null
      },
      {
        label: "能耗",
        icon: "leaf",
        value: s.efficiency,
        unit: fmt.unit.cons,
        sub: "按充电推算"
      }
    ],
    { cols: 2 }
  );

  // 两边合起来是全部，用 fmt.shares 分（各自四舍五入可能加起来是 101%）
  const [acPct, dcPct] = fmt.shares([acdc.AC, acdc.DC]);
  const acdcCard =
    acdcTotal > 0
      ? ui.card(
          html`<div class="tm-between pg-battery-acdc-head">
              <span class="tm-strong">交流 / 直流</span>
              <span class="tm-note">从电网取的电量</span>
            </div>
            <div class="pg-battery-split" role="img" aria-label="${`交流 ${acPct}，直流 ${dcPct}`}">
              ${acdc.AC > 0 ? html`<span class="is-ac" style="flex:${acdc.AC.toFixed(3)}"></span>` : ""}
              ${acdc.DC > 0 ? html`<span class="is-dc" style="flex:${acdc.DC.toFixed(3)}"></span>` : ""}
            </div>
            <div class="pg-battery-split-legend">
              <div><i class="is-ac"></i><span>交流（慢充）</span><b>${fmt.kwh(acdc.AC, 1)}</b><em>${acPct}</em></div>
              <div><i class="is-dc"></i><span>直流（快充）</span><b>${fmt.kwh(acdc.DC, 1)}</b><em>${dcPct}</em></div>
            </div>`
        )
      : "";

  const chargeSection = ui.section(
    "充电",
    html`<div class="tm-stack">
      ${ui.stats(
        [
          { label: "充电次数", icon: "ev-station", value: s.charges ?? 0, unit: "次" },
          { label: "充入电池", icon: "battery-charging-high", value: s.added, digits: kwhDigits(s.added), unit: "kWh" },
          { label: "从电网取电", icon: "power-plug-outline", value: s.used, digits: kwhDigits(s.used), unit: "kWh" },
          { label: "充电效率", icon: "flash-outline", value: chargeEff == null ? null : chargeEff * 100, digits: 1, unit: "%", sub: "充入 ÷ 取电" }
        ],
        { cols: 2 }
      )}
      ${acdcCard}
    </div>`,
    { action: { href: ctx.href("/stats/charging"), label: "充电统计" } }
  );

  const driveSection = ui.section(
    "行驶",
    ui.stats(
      [
        { label: "里程表", icon: "counter", value: s.odometer, unit: fmt.unit.len },
        { label: "记录以来行驶", icon: "road-variant", value: s.mileage, unit: fmt.unit.len, sub: "里程表增加" },
        { label: "已记录行程", icon: "map-marker-path", value: s.logged, unit: fmt.unit.len, sub: "行程距离合计" },
        {
          label: "未记录",
          icon: "map-marker-question-outline",
          value: dataLost,
          unit: fmt.unit.len,
          tone: dataLost > 0 ? "amber" : null,
          sub: dataLost > 0 ? "停机或断网时漏记" : "没有漏记"
        }
      ],
      { cols: 2 }
    ),
    { action: { href: ctx.href("/stats/drives"), label: "行程" } }
  );

  const hasCurve = d.points.length > 0;

  ui.render(
    ctx.root,
    html`
      <div class="pg-battery-top">${hero}${keyStats}</div>
      ${ui.section(
        "电池容量随里程变化",
        ui.card(
          hasCurve
            ? html`${ui.legend([
                { label: "充电推算的容量（每天）", color: "var(--tm-c1)" },
                { label: "半月中位数", color: "var(--tm-c2)" }
              ])}${ui.chartBox("pg-battery-cap", { height: 300, heightMobile: 240, label: "电池容量随里程变化" })}`
            : ui.empty("还没有充入足够电量的充电记录，画不出容量变化。", { icon: "chart-scatter-plot" })
        ),
        { sub: hasCurve ? "每个点是一天里各次充电结束时推算的容量。越往右越新，折线往下走说明容量在变小。" : null }
      )}
      <div class="tm-grid-2">${chargeSection}${driveSection}</div>
      ${ui.details(
        "这些数字是怎么算的",
        html`<dl class="pg-battery-faq">
          <dt>可用容量（现在）</dt>
          <dd>最近 100 条充电记录里，用「额定续航 × 能耗 ÷ 可用电量」推算出的电池容量取平均。</dd>
          <dt>可用容量（新车）</dt>
          <dd>TeslaMate 开始记录以来，单次充电推算出的最大容量。不是从新车开始记录的（比如二手车），这个值会偏低，衰减也会显得偏小。</dd>
          <dt>当前电量</dt>
          <dd>最近一条位置或充电记录里的可用电量（和面板 Current SOC 一样），天冷时会比车上显示的电量低 1–3%。后面的 kWh 是它乘以现在的可用容量。</dd>
          <dt>满电续航</dt>
          <dd>现在：最近一条记录的续航换算到 100% 电量；新车：按天汇总的续航 ÷ 电量里最高的一天。</dd>
          <dt>能耗</dt>
          <dd>TeslaMate 根据充电前后续航变化推算的额定能耗，没有足够的充电时用车型自带的值。</dd>
          <dt>充电循环</dt>
          <dd>累计充入电池的电量 ÷ 新车容量，向下取整。</dd>
          <dt>未记录里程</dt>
          <dd>「记录以来行驶」减去「已记录行程」，是 TeslaMate 没记下的行驶距离，比如停机、断网或出错时。</dd>
        </dl>`
      )}
    `
  );

  if (!hasCurve) return;

  const pts = d.points.map((r) => [r.odometer, r.kwh, r.day]);
  const med = d.median.map((r) => [r.odometer, r.kwh, r.title]);
  // 半月中位数按「2026091」（年月 + 上 / 下半月）查，写进每天那个点的提示框
  const medBy = new Map(d.median.map((r) => [String(r.title), r]));
  const all = pts.map((p) => p[1]).concat(med.map((p) => p[1]));
  if (capNew != null) all.push(capNew);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  // 纵轴不从 0 开始（容量只差几个 kWh），上下各留一点并取整，新车容量那条虚线也要在图里
  const pad = Math.max(0.3, (hi - lo) * 0.1);

  await chart.create(ctx.root.querySelector("#pg-battery-cap"), {
    // 里程轴：两端贴着数据（各留 2%，首尾的点不贴边），整刻度按图宽挑
    xAxis: chart.valueAxis({ unit: fmt.unit.len, nice: true, pad: 0.02, splitLine: { show: false }, axisLine: { show: true } }),
    yAxis: chart.valueAxis({ unit: "kWh", min: Math.floor(lo - pad), max: Math.ceil(hi + pad) }),
    // 图例画在图外（ui.legend）
    legend: { show: false },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const v = p.value;
        // 每天一个点：标题写「9月24日 周四」（整天的点，和别的图一样），顺带写上这一天所在半个月的中位数
        const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v[2]);
        const half = ymd ? medBy.get(`${ymd[1]}${ymd[2]}${+ymd[3] <= 15 ? 1 : 2}`) : null;
        return chart.tipHtml(ymd ? chart.timeTitle(new Date(+ymd[1], +ymd[2] - 1, +ymd[3]).getTime()) : v[2], [
          { color: p.color, name: "推算容量", value: fmt.kwh(v[1], 1) },
          half ? { color: chart.color("c2"), name: "半月中位数", value: fmt.kwh(half.kwh, 1) } : null,
          { name: "里程表", value: fmt.len(v[0], 0) }
        ]);
      }
    },
    series: [
      {
        type: "scatter",
        name: "推算容量",
        data: pts,
        // 点用不透明的 c1（半透明的点贴在卡片底色上对比度不到 3:1，和图例色块也对不上），
        // 重叠的地方靠一圈卡片底色的描边分开
        symbolSize: 6,
        z: 2,
        itemStyle: { color: "@c1", borderColor: "@surface", borderWidth: 1 },
        markLine:
          capNew != null
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: "@hint", type: "dashed", width: 1 },
                label: { formatter: `新车 ${fmt.num(capNew, 1)}`, position: "insideEndTop", color: "@text-2", fontSize: 11 },
                data: [{ yAxis: capNew }]
              }
            : undefined
      },
      {
        type: "line",
        name: "半月中位数",
        data: med,
        z: 3,
        lineStyle: { color: "@c2", width: 2.5 },
        itemStyle: { color: "@c2" },
        // 中位数线只看不点（silent，和充电统计的快充中位数线一样）：它的节点就落在每天的点上，能点的话会盖住那些点、
        // 抢走它们的提示框。中位数写在每天那个点的提示框里
        silent: true,
        // 点少时（比如刚接入的车）把节点画出来，不然一两个点的「线」看不见
        showSymbol: med.length < 3,
        symbolSize: 6
      }
    ],
    dataZoom: pts.length > 60 ? chart.zoom() : undefined
  });
}
