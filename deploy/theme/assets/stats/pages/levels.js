// 电量和里程（对应 Grafana 面板 Charge Level，WopVO_mgz；Mileage，NjtMTFggz）
//
// 电量图照 Charge Level：电量 / 可用电量按 2 分钟取平均；面板的 20% 和 80%（磷酸铁锂 100%）两条参考线；
// 可选的移动平均 / 分位带（面板变量 include_average_percentiles，默认开，URL 参数 band=0 关掉）。
// 分位带的两个高级参数用面板默认值：先按 2 小时分桶，窗口是时间范围的 1/6（半年是 29 天，实际前后各 14 天）。
// 里程图照 Mileage：每次行程开始 / 结束时的里程表读数。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { series, calcs, legendTable } from "./_series.js";
import { lenDigits } from "./_drive-item.js";

export const title = "电量和里程";
export const range = { default: "180d" };
export const css = true;

// 面板变量的默认值：bucket_width = 2h（7200 秒），intervals_moving_average_percentiles = 6（窗口是范围的 1/6）
const BUCKET = 7200;
const WINDOW_PARTS = 6;

const SOC_SQL = `SELECT
    date_bin('2 minutes'::interval, timezone('UTC', date), to_timestamp(\${__from:date:seconds})) AS time,
    avg(battery_level) AS level,
    avg(usable_battery_level) AS usable
  FROM positions
  WHERE $__timeFilter(date) AND car_id = $car_id AND ideal_battery_range_km IS NOT NULL
  GROUP BY time
  ORDER BY time ASC`;

// 面板 Charge Level B：两条参考线（面板里是阈值线），磷酸铁锂车的上面那条是 100
const LIMITS_SQL = `SELECT 20 AS lower, CASE WHEN lfp_battery THEN 100 ELSE 80 END AS upper, lfp_battery AS lfp
  FROM cars INNER JOIN car_settings ON cars.settings_id = car_settings.id
  WHERE cars.id = $car_id`;

// 面板 Charge Level C：位置点不均匀（开车时密、睡着时稀），所以先按固定宽度分桶、空桶沿用上一个值，
// 再在前后各半个窗口里算平均和分位数。
// 分桶、补空桶这几步照抄面板；最后一步（窗口里的平均和分位数）挪到前端 movingBand() 算，结果一样。
// 面板那一步对每个桶都 array_agg 整个窗口再排序三遍，代价是「桶数 × 窗口」：半年 1 秒，
// 选「全部」（2010 年起，窗口 1018 天）要两分多钟，页面一直停在骨架上。前端用滑动的有序数组，一两百毫秒。
// 只返回第一个有记录的桶以后的行：之前的桶都是空的，不在任何窗口里贡献数值，去掉不影响结果。
// out：面板最外层的过滤条件（在时间范围内、桶里有记录），为 false 的行只参与窗口，不画出来
const BAND_SQL = `with positions_filtered as (
    select date, battery_level
    from positions p
    where p.car_id = $car_id
      and p.ideal_battery_range_km is not null
      and 1 = $include_average_percentiles
  ),
  gen_date_series as (
    select generate_series(
      to_timestamp(\${__from:date:seconds} - (86400 * $days_moving_average_percentiles / 2)),
      to_timestamp(\${__to:date:seconds}),
      concat($bucket_width, ' seconds')::INTERVAL
    ) as series_id
  ),
  date_series as (
    select
      timezone('UTC', series_id) as series_id,
      timezone('UTC', lead(series_id) over (order by series_id asc)) as next_series_id
    from gen_date_series
  ),
  positions_bucketed as (
    select series_id, avg(battery_level) as battery_level, min(positions_filtered.date) as series_min_date
    from date_series
      left join positions_filtered on
        positions_filtered.date >= date_series.series_id
        and positions_filtered.date < date_series.next_series_id
    group by series_id
  ),
  positions_bucketed_gapfilling_locf_intermediate as (
    select series_id, battery_level, series_min_date, count(battery_level) over (order by series_id) as i
    from positions_bucketed
  ),
  positions_bucketed_gapfilled_locf as (
    select series_id, series_min_date, max(battery_level) over (partition by i) as battery_level_locf
    from positions_bucketed_gapfilling_locf_intermediate
  )
  select
    series_id::timestamptz as time,
    battery_level_locf as v,
    (series_min_date is not null and $__timeFilter(series_id)) as out
  from positions_bucketed_gapfilled_locf
  where series_id >= (select min(series_id) from positions_bucketed where series_min_date is not null)
  order by series_id`;

// 面板 C 的最后一步：每个桶前后各 n 个桶（按行数，和 SQL 的 rows between n preceding and n following 一样）里
// 空值不算的平均、percentile_cont(0.075 / 0.5 / 0.925)（线性插值）。窗口是一个有序数组，往后挪一格就插一个、删一个
function movingBand(rows, n) {
  const win = [];
  let sum = 0;
  const pos = (x) => {
    let a = 0;
    let b = win.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (win[m] < x) a = m + 1;
      else b = m;
    }
    return a;
  };
  const add = (x) => {
    if (x == null) return;
    win.splice(pos(x), 0, x);
    sum += x;
  };
  const drop = (x) => {
    if (x == null) return;
    win.splice(pos(x), 1);
    sum -= x;
  };
  const pc = (p) => {
    const at = p * (win.length - 1);
    const i = Math.floor(at);
    return i + 1 < win.length ? win[i] + (win[i + 1] - win[i]) * (at - i) : win[i];
  };
  const out = [];
  let hi = -1;
  for (let j = 0; j < rows.length; j++) {
    while (hi < Math.min(rows.length - 1, j + n)) add(rows[++hi].v);
    if (j - n - 1 >= 0) drop(rows[j - n - 1].v);
    if (!rows[j].out || !win.length) continue;
    out.push({ time: rows[j].time, p075: pc(0.075), avg: sum / win.length, p50: pc(0.5), p925: pc(0.925) });
  }
  return out;
}

// 面板 Mileage：行程起止两个时刻的里程表读数（没结束的行程 end_date 为空，被时间过滤掉）
const ODO_SQL = `WITH o AS (
    SELECT start_date AS time, car_id, start_km AS odometer FROM drives
    UNION ALL
    SELECT end_date, car_id, end_km AS odometer FROM drives
  )
  SELECT time, convert_km(odometer::numeric, '$length_unit') AS mileage
  FROM o
  WHERE car_id = $car_id AND $__timeFilter(time)
  ORDER BY 1`;

export async function render(ctx) {
  const band = ctx.query.get("band") !== "0";

  // 窗口天数：面板变量 days_moving_average_percentiles 的算法（整数除法），半年 → 29 天
  const fromS = Math.floor(ctx.range.from / 1000);
  const toS = Math.floor(ctx.range.to / 1000);
  const days = Math.trunc(Math.trunc((toS - fromS) / 86400) / WINDOW_PARTS);
  // SQL 里窗口是前后各 (86400 / bucket) × (days / 2) 个桶，days / 2 也是整数除法：29 天实际是前后各 14 天。
  // 范围不到 12 天时是 0，每个点只有它自己那 2 小时，四条线都等于 2 小时平均，画出来没意义（Grafana 照画），这里不查
  const half = Math.trunc(days / 2);
  const bandOn = band && half > 0;

  ui.render(ctx.root, ui.skeleton(["stats", "chart", "chart"]));

  const d = await api.batch(
    {
      soc: SOC_SQL,
      limits: LIMITS_SQL,
      band: bandOn
        ? {
            sql: BAND_SQL,
            vars: { bucket_width: BUCKET, include_average_percentiles: 1, days_moving_average_percentiles: days }
          }
        : null,
      odo: ODO_SQL
    },
    { signal: ctx.signal }
  );

  const level = series(d.soc, "level");
  const usable = series(d.soc, "usable");
  const odo = series(d.odo, "mileage");
  const bandRows = bandOn ? movingBand(d.band, (86400 / BUCKET) * half) : [];
  const lim = d.limits[0] || { lower: 20, upper: 80, lfp: false };

  if (!level.length && !odo.length) {
    ui.render(
      ctx.root,
      ui.card(
        ui.empty(`${ctx.range.label}没有电量和里程记录。`, {
          icon: "chart-timeline-variant",
          title: "没有电量和里程记录",
          action: ctx.range.key !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/levels", { r: "all", band: ctx.query.get("band") }) }) : null
        })
      )
    );
    return;
  }

  const lc = calcs(level);
  const uc = calcs(usable);
  const oc = calcs(odo);
  const pct0 = (v) => fmt.pct(v, 0);
  // 里程表读数一律取整（各页统一）；「期间行驶」是距离，按距离的写法（不到 100 留一位）
  const odoF = (v) => fmt.len(v, 0);
  // 分位带没有点时（比如范围里只有最后 2 小时有记录，面板的 SQL 算不出来）图例表里不列这四行，免得一排「—」
  const bandSeries = bandRows.length
    ? [
        { key: "avg", name: "移动平均", color: "c5", dashed: true },
        { key: "p50", name: "移动中位数", color: "c5" },
        { key: "p925", name: "92.5% 分位", color: "c5" },
        { key: "p075", name: "7.5% 分位", color: "c5" }
      ].map((s) => ({ ...s, data: series(bandRows, s.key) }))
    : [];
  let bandNote = "";
  if (bandRows.length) {
    bandNote = `移动平均和分位数：先按 2 小时取平均（没有记录的时段沿用上一个值），再在前后各 ${half} 天的窗口里算；浅色带是 7.5–92.5% 分位，实线是中位数，虚线是平均。窗口是所选时间范围的 1/6。`;
    // 选「全部」这类很长的范围时，窗口比整段记录还长，每个点算的都是全部记录，几条线是平的（Grafana 也一样）
    const span = bandRows[bandRows.length - 1].time - bandRows[0].time;
    if (half * 86400e3 >= span) bandNote += "这段范围的窗口比整段记录还长，所以几条线是平的，就是全部记录的平均和分位数。";
  } else if (band && !half) {
    bandNote = "移动平均 / 分位带的窗口是所选时间范围的 1/6，范围不到 12 天时窗口不足一天，就不画了。选长一点的范围（比如近半年）再看。";
  } else if (band) {
    bandNote = "这段时间的记录太少，算不出移动平均 / 分位带。";
  }

  // 某一节没有数据时只放空状态，不再摆一排「—」的数字
  const socSection = ui.section(
    "电量",
    html`<div class="tm-stack">
      ${level.length > 0 &&
      ui.stats(
        [
          {
            label: "平均电量",
            icon: "battery-50",
            value: lc.mean,
            unit: "%",
            sub: uc.mean == null ? null : `可用电量平均 ${fmt.pct(uc.mean, 0)}`
          },
          {
            label: "电量范围",
            icon: "battery-outline",
            value: lc.min == null ? null : `${fmt.num(lc.min, 0)}–${fmt.num(lc.max, 0)}`,
            unit: "%",
            sub: uc.min == null ? null : `可用电量 ${fmt.num(uc.min, 0)}–${fmt.pct(uc.max, 0)}`
          }
        ],
        { cols: 2 }
      )}
      ${ui.card(
        level.length
          ? html`<div class="pg-levels-tools">
                <span class="tm-note">虚线是 ${lim.lower}%${lim.upper < 100 ? ` 和 ${lim.upper}%` : ""} 参考线</span>
                ${half > 0 && html`<button type="button" class="tm-chip" data-band aria-pressed="${band ? "true" : "false"}">移动平均 / 分位带</button>`}
              </div>
              ${ui.chartBox("pg-levels-soc", { height: 300, heightMobile: 250, label: "电量随时间变化" })}
              ${legendTable([
                { name: "电量", color: "c1", data: level, fmt: pct0 },
                { name: "可用电量", color: "c2", data: usable, fmt: pct0 },
                ...bandSeries.map((s) => ({ ...s, fmt: pct0 }))
              ])}
              ${bandNote && html`<p class="tm-note pg-levels-note">${bandNote}</p>`}`
          : ui.empty(`${ctx.range.label}没有电量记录。`, { icon: "battery-50" })
      )}
    </div>`
  );

  // 和旁边的「27,991 km」「期初 22,360 km」自己减一下对得上：两头按显示的样子取整再相减。
  // 不到 100 时写一位小数（lenDigits），两头也按一位小数取
  const droveDigits = lenDigits(oc.max != null && oc.min != null ? oc.max - oc.min : null);
  const drove = fmt.roundDiff(oc.max, oc.min, droveDigits);
  const odoSection = ui.section(
    "里程",
    html`<div class="tm-stack">
      ${odo.length > 0 &&
      ui.stats(
        [
          {
            label: "期间行驶",
            icon: "road-variant",
            value: drove,
            digits: droveDigits,
            unit: fmt.unit.len,
            sub: ctx.range.label
          },
          {
            label: "里程表",
            icon: "counter",
            value: oc.max,
            unit: fmt.unit.len,
            sub: oc.min == null ? null : `期初 ${odoF(oc.min)}`
          }
        ],
        { cols: 2 }
      )}
      ${ui.card(
        odo.length
          ? html`${ui.chartBox("pg-levels-odo", { height: 260, heightMobile: 220, label: "里程表读数随时间变化" })}
              ${legendTable([{ name: "里程表", color: "c3", data: odo, fmt: odoF }], {
                cols: [
                  { key: "min", label: "最低" },
                  { key: "max", label: "最高" }
                ]
              })}`
          : ui.empty(`${ctx.range.label}没有行程。`, { icon: "road-variant" })
      )}
    </div>`,
    { action: { href: ctx.href("/stats/drives"), label: "行程" } }
  );

  ui.render(ctx.root, html`${socSection}${odoSection}`);

  const chip = ctx.root.querySelector("[data-band]");
  if (chip) chip.addEventListener("click", () => ctx.setQuery({ band: band ? "0" : null }));

  const jobs = [];
  if (level.length) {
    const ref = (y) => ({ yAxis: y, label: { formatter: `${y}%` } });
    // 半年 8000 来个点、一年 1.6 万个，不降采样（核心默认就不降），指针高亮的点和提示框里的数才对得上
    const socSeries = [
      {
        ...chart.line("电量", level, { color: "c1", area: true, width: 1, z: 2 }),
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "@green", type: "dashed", width: 1 },
          label: { position: "insideStartTop", color: "@green", fontSize: 11 },
          data: [ref(lim.lower), lim.upper < 100 ? ref(lim.upper) : null].filter(Boolean)
        }
      },
      // 可用电量压在电量下面：两条大部分时间重合，只有天冷时可用电量低一点，从蓝线下面露出来
      chart.line("可用电量", usable, { color: "c2", width: 1, z: 1 })
    ];
    if (bandRows.length) {
      // 分位带：7.5% 那条透明打底，上面叠一层「92.5% − 7.5%」的面积（ECharts 画区间带的常用做法）
      socSeries.push(
        {
          type: "line",
          name: "_bandLow",
          data: bandRows.map((r) => [r.time, r.p075]),
          stack: "band",
          showSymbol: false,
          lineStyle: { opacity: 0 },
          silent: true,
          z: 3,
          showInLegend: false
        },
        {
          type: "line",
          name: "_bandHigh",
          data: bandRows.map((r) => [r.time, r.p925 - r.p075]),
          stack: "band",
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: { color: "@c5/0.22" },
          silent: true,
          z: 3,
          showInLegend: false
        },
        chart.line(bandSeries[1].name, bandSeries[1].data, { color: "c5", width: 2, z: 4 }),
        chart.line(bandSeries[0].name, bandSeries[0].data, { color: "c5", width: 1.5, dashed: true, z: 4 })
      );
    }
    // 提示框：电量是 2 分钟一个点、分位带是 2 小时一个点，横轴对不齐，按指针时刻去各组数据里找最近的点。
    // 标题用最近那个电量点的时刻（没有就用指针时刻）。点都是某个时刻，0 点那个也写「00:00」，不写成整天的「周四」
    const H = 3600e3;
    const bandTip = bandRows.length
      ? [
          { name: "移动中位数", data: bandSeries[1].data, color: "c5", fmt: pct0 },
          { name: "移动平均", data: bandSeries[0].data, color: "c5", fmt: pct0 },
          {
            name: "分位带",
            data: bandRows.map((r) => [r.time, r.p075, r.p925]),
            color: "@c5/0.35",
            fmt: (v, p) => `${fmt.num(p[1], 0)}–${fmt.pct(p[2], 0)}`
          }
        ].map((l) => ({ ...l, maxGap: 2 * H }))
      : [];
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-levels-soc"), {
        // 图例画在图下面的表里
        legend: { show: false },
        xAxis: chart.timeAxis({ min: "dataMin", max: "dataMax" }),
        yAxis: chart.valueAxis({ unit: "%", min: 0, max: 100 }),
        tooltip: chart.nearestTooltip(
          [
            { name: "电量", data: level, color: "c1", fmt: pct0 },
            { name: "可用电量", data: usable, color: "c2", fmt: pct0 },
            ...bandTip
          ],
          {
            maxGap: 3 * H,
            title: (t) => {
              const p = chart.nearest(level, t, 3 * H);
              return fmt.dateTime(p ? p[0] : t);
            }
          }
        ),
        series: socSeries,
        dataZoom: chart.zoom()
      })
    );
  }
  if (odo.length) {
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-levels-odo"), {
        xAxis: chart.timeAxis({ min: "dataMin", max: "dataMax" }),
        yAxis: chart.valueAxis({ unit: fmt.unit.len, scale: true }),
        series: [chart.line("里程表", odo, { color: "c3", area: true, fmt: odoF })],
        dataZoom: chart.zoom()
      })
    );
  }
  await Promise.all(jobs);
}
