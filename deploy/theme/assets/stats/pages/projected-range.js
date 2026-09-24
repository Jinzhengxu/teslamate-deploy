// 续航变化（对应 Grafana 面板 Projected Range，riqUfXgRz）
//
// 「满电续航」= 某段时间里的续航之和 ÷ 电量之和 × 100，也就是把当时的续航按比例换算到 100% 电量。
// 面板有三张图，都是它和另一个量放在一起看：里程、电量、车外温度。时间粒度（面板变量 interval）默认 6 小时，
// 做成页面上的分段选择（URL 参数 iv）。SQL 照抄面板，只把列名换成英文别名，时间列由 $__timeGroup 交给 Grafana 算。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { series, calcs, lenAuto, lenNum, legendTable, bindLegendToggle } from "./_series.js";

export const title = "续航变化";
export const range = { default: "180d" };
export const css = true;

const INTERVALS = [
  { value: "5m", label: "5分" },
  { value: "15m", label: "15分" },
  { value: "30m", label: "30分" },
  { value: "1h", label: "1小时" },
  { value: "3h", label: "3小时" },
  { value: "6h", label: "6小时" }
];
const DEFAULT_IV = "6h";

// 面板里三张图共用的数据源：行驶 / 停车时的位置点（只要有续航的完整记录）+ 充电记录
const DATA = `(
    select battery_level, usable_battery_level, date, rated_battery_range_km, ideal_battery_range_km, outside_temp
    from positions
    where car_id = $car_id and $__timeFilter(date) and ideal_battery_range_km is not null
    union all
    select battery_level, coalesce(usable_battery_level, battery_level) as usable_battery_level, date,
      rated_battery_range_km, ideal_battery_range_km, outside_temp
    from charges c
      join charging_processes p ON p.id = c.charging_process_id
    where $__timeFilter(date) and p.car_id = $car_id
  ) as data`;

const RANGE_EXPR = `convert_km((sum(\${preferred_range}_battery_range_km) / nullif(sum(coalesce(usable_battery_level, battery_level)), 0) * 100)::numeric, '$length_unit')`;

const QUERIES = {
  // 图一 A：满电续航
  range: `SELECT $__timeGroup(date, $interval) AS time, ${RANGE_EXPR} AS v
    FROM ${DATA}
    GROUP BY 1
    HAVING ${RANGE_EXPR} IS NOT NULL
    ORDER BY 1`,
  // 图一 B：里程表
  mileage: `SELECT $__timeGroup(date, $interval) AS time, convert_km(avg(odometer)::numeric, '$length_unit') AS v
    FROM positions
    WHERE $__timeFilter(date) AND car_id = $car_id AND ideal_battery_range_km IS NOT NULL
    GROUP BY 1
    ORDER BY 1`,
  // 图二、图三 A：两种算法的满电续航（按可用电量修正 / 直接按电量）
  ranges: `SELECT $__timeGroup(date, $interval) AS time,
      convert_km((sum(\${preferred_range}_battery_range_km) / sum(battery_level) * 100)
        - (sum(\${preferred_range}_battery_range_km) / sum(battery_level) * 100 * (avg(battery_level) - avg(coalesce(usable_battery_level, battery_level))) / 100), '$length_unit') AS usable,
      convert_km(max(\${preferred_range}_battery_range_km) / max(battery_level) * 100, '$length_unit') AS level
    FROM ${DATA}
    GROUP BY 1
    ORDER BY 1`,
  // 图二 B：电量、可用电量（充电记录那一半的可用电量取 NULL，按电量算，面板就是这样）
  levels: `SELECT $__timeGroup(date, $interval) AS time,
      avg(battery_level) AS level,
      avg(coalesce(usable_battery_level, battery_level)) AS usable
    FROM (
      SELECT battery_level, usable_battery_level, date
      FROM positions
      WHERE car_id = $car_id AND $__timeFilter(date) AND ideal_battery_range_km IS NOT NULL
      UNION ALL
      SELECT battery_level, null AS usable_battery_level, date
      FROM charges c
        JOIN charging_processes p ON p.id = c.charging_process_id
      WHERE $__timeFilter(date) AND p.car_id = $car_id
    ) AS data
    GROUP BY 1
    ORDER BY 1`,
  // 图三 B：车外温度
  temp: `SELECT $__timeGroup(date, $interval) AS time, avg(convert_celsius(outside_temp, '$temp_unit')) AS v
    FROM positions
    WHERE $__timeFilter(date) AND car_id = $car_id AND ideal_battery_range_km IS NOT NULL
    GROUP BY 1
    ORDER BY 1`
};

function lineOf(l) {
  const s = chart.line(l.name, l.data, { color: l.color, yAxisIndex: l.right ? 1 : 0, fmt: l.fmt, ...l.opts });
  // 次要的线：细一点、淡一点、压在主线下面，三四条线叠在一起时主线还能看清。
  // l.z 可以再排一下次要线之间的上下（电量压在可用电量上面，两条重合时看到的是图例里电量的颜色，不是混出来的土黄）
  if (l.faint) Object.assign(s, { z: l.z ?? 1, lineStyle: { ...(s.lineStyle || {}), width: 1, opacity: l.faint } });
  return s;
}

const IV_MS = { "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "3h": 10800e3, "6h": 21600e3 };

export async function render(ctx) {
  const iv = api.oneOf(ctx.query.get("iv"), INTERVALS.map((o) => o.value), DEFAULT_IV);
  ctx.setGrafanaVars(iv === DEFAULT_IV ? null : { "var-interval": iv });

  ui.render(ctx.root, ui.skeleton(["stats", "chart", "chart"]));

  const d = await api.batch(QUERIES, { signal: ctx.signal, vars: { interval: iv } });

  const proj = series(d.range, "v");
  const usable = series(d.ranges, "usable");

  const toolbar = ui.segmented("iv", INTERVALS, iv, { prefix: "时间粒度" });
  // 三张图下面的表怎么看、怎么用，说一次就够（原来只写在第三张图的标题下面）
  const tableHint = html`<p class="tm-note">每张图下面的表是范围内各点的平均、最高、最低；点表里的一行可以隐藏 / 显示那条线，三张图的缩放和提示框是联动的。</p>`;
  const onIv = () => ui.onSegment(ctx.root, "iv", (v) => ctx.setQuery({ iv: v === DEFAULT_IV ? null : v }));

  if (!proj.length && !usable.length) {
    ui.render(
      ctx.root,
      html`${toolbar}${ui.card(ui.empty(`${ctx.range.label}没有续航记录。换个时间范围看看。`, { icon: "gauge", title: "没有数据" }))}`
    );
    onIv();
    return;
  }

  const pctF = (v) => fmt.pct(v, 0);
  const tempF = (v) => fmt.temp(v, 1);
  const kind = ctx.settings.preferredRange === "ideal" ? "理想" : "额定";
  const level = series(d.ranges, "level");

  // 三张图：每条线的名字、颜色、数据、格式、画法。图、图例表、提示框都从这里生成
  const CHARTS = [
    {
      id: "pg-range-mileage",
      title: "满电续航与里程",
      sub: `把${kind}续航按比例换算到 100% 电量；电池衰减会让它随里程慢慢往下走。`,
      right: { unit: fmt.unit.len, scale: true },
      lines: [
        { name: "满电续航", color: "c1", data: proj, fmt: lenAuto, opts: { area: true, z: 3 } },
        { name: "里程", color: "c3", data: series(d.mileage, "v"), fmt: lenAuto, right: true, opts: { step: "end", width: 2, z: 2 } }
      ]
    },
    {
      id: "pg-range-level",
      title: "满电续航与电量",
      sub: "天冷时电池有一部分电量暂时用不了（可用电量低于电量），按电量算的续航会偏低。",
      right: { unit: "%", min: 0, max: 100 },
      lines: [
        { name: "按可用电量", color: "c1", data: usable, fmt: lenAuto, opts: { z: 3 } },
        { name: "按电量", color: "c5", data: level, fmt: lenAuto, faint: 0.8 },
        { name: "电量", color: "c4", data: series(d.levels, "level"), fmt: pctF, right: true, faint: 0.55, z: 2 },
        { name: "可用电量", color: "c2", data: series(d.levels, "usable"), fmt: pctF, right: true, faint: 0.55, z: 1 }
      ]
    },
    {
      id: "pg-range-temp",
      title: "满电续航与车外温度",
      sub: "看满电续航和气温的关系：天冷时通常偏低，天暖后回升。",
      right: { unit: fmt.unit.temp, scale: true },
      lines: [
        { name: "按可用电量", color: "c1", data: usable, fmt: lenAuto, opts: { z: 3 } },
        { name: "按电量", color: "c5", data: level, fmt: lenAuto, faint: 0.8 },
        { name: "车外温度", color: "c2", data: series(d.temp, "v"), fmt: tempF, right: true, faint: 0.7 }
      ]
    }
  ];

  const rc = calcs(proj);
  const lastT = proj.length ? proj[proj.length - 1][0] : null;

  ui.render(
    ctx.root,
    html`
      ${ui.stats([
        { label: "最近满电续航", icon: "gauge", value: lenNum(rc.last), unit: fmt.unit.len, sub: lastT ? fmt.dateTime(lastT) : null },
        { label: "平均", icon: "chart-line", value: lenNum(rc.mean), unit: fmt.unit.len, sub: ctx.range.label },
        { label: "最高", icon: "arrow-up", value: lenNum(rc.max), unit: fmt.unit.len },
        { label: "最低", icon: "arrow-down", value: lenNum(rc.min), unit: fmt.unit.len }
      ])}
      <div class="tm-stack">${toolbar}${tableHint}</div>
      ${CHARTS.map((c) =>
        ui.section(
          c.title,
          ui.card(
            html`${ui.chartBox(c.id, { height: 280, heightMobile: 230, label: c.title })}${legendTable(c.lines, { chart: c.id, toggle: true, shortUnits: true })}`
          ),
          { sub: c.sub }
        )
      )}
    `
  );
  onIv();

  // 被图例表关掉的线。option 传函数：换主题时 chart.js 会重新生成 option，关掉的线要保持关着
  const hidden = new Map(CHARTS.map((c) => [c.id, new Set()]));
  const rightAxis = (opts) => chart.valueAxis({ position: "right", splitLine: { show: false }, ...opts });
  const optionOf = (c) => () => ({
    // 图例画在图下面的表里，ECharts 自带的关掉
    legend: { show: false, selected: Object.fromEntries(c.lines.map((l) => [l.name, !hidden.get(c.id).has(l.name)])) },
    dataZoom: chart.zoom(),
    // 三张图都用数据的首尾当横轴范围，联动时对得齐
    xAxis: chart.timeAxis({ min: "dataMin", max: "dataMax" }),
    // 满电续航的纵轴不从 0 开始（面板是从 200 开始），按数据上下留一点
    yAxis: [chart.valueAxis({ unit: fmt.unit.len, scale: true }), rightAxis(c.right)],
    // 各条线来自不同的查询（位置点 + 充电 / 只有位置点），不是每个时间桶都有：按指针时刻去每条线里找同一个桶。
    // 图例表关掉的线，提示框里也不显示（nearestTooltip 读图表的图例状态）
    tooltip: chart.nearestTooltip(
      c.lines.map((l) => ({ name: l.name, data: l.data, color: l.color, fmt: l.fmt })),
      { maxGap: IV_MS[iv] / 2 }
    ),
    series: c.lines.map(lineOf)
  });

  const insts = await Promise.all(CHARTS.map((c) => chart.create(ctx.root.querySelector("#" + c.id), optionOf(c))));
  if (insts.some((i) => !i)) return;

  // 联动：三张图的缩放和提示框同步（离开页面核心自动断开）
  chart.connect(insts);

  // 点图例表的一行：隐藏 / 显示对应的线
  bindLegendToggle(ctx.root, new Map(CHARTS.map((c, i) => [c.id, { inst: insts[i], hidden: hidden.get(c.id) }])));
}
