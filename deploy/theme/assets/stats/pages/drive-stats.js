// 驾驶统计（对应 Grafana「Drive Stats」_7WkNSyWk）：里程、耗电、速度分布、常去的地方
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { placeSql } from "./_shared.js";

export const title = "驾驶统计";
export const range = { default: "1y" };
export const css = true;

const DAY = 86400e3;

// 面板顶上三格（行程数、总里程、净耗电）和两格「日均」都来自同一条逐日序列：
// 从「第一次行程那天」和「范围起点」里较晚的一天，到范围终点那天，每天一行（没开车的天是 0）。
// 日均 = 合计 ÷ 行数，和 Grafana stat 面板对这条序列取 mean 一样。三条 SQL 合成一条，少两次往返。
const DAILY_SQL = `
WITH since AS (
  SELECT timezone('UTC', min(start_date)) AS date FROM drives WHERE car_id = $car_id GROUP BY car_id
),
actual AS (
  SELECT date_trunc('day', timezone('UTC', start_date), '$__timezone') AS date,
         count(*) AS n,
         sum(distance) AS distance,
         sum((start_\${preferred_range}_range_km - end_\${preferred_range}_range_km) * cars.efficiency) AS energy
  FROM drives
  INNER JOIN cars ON drives.car_id = cars.id
  WHERE car_id = $car_id AND $__timeFilter(start_date) AND end_date IS NOT NULL
  GROUP BY 1
),
base_line AS (
  SELECT date FROM generate_series(date_trunc('day', (SELECT date FROM since), '$__timezone'), date_trunc('day', timestamp with time zone $__timeTo(), '$__timezone'), '1 day'::interval, '$__timezone') date
)
SELECT base_line.date AS day,
       COALESCE(actual.n, 0) AS n,
       convert_km(COALESCE(actual.distance, 0)::numeric, '$length_unit') AS dist,
       COALESCE(actual.energy, 0) AS energy
FROM base_line
LEFT JOIN actual ON actual.date = base_line.date
WHERE date_trunc('day', timestamp with time zone $__timeFrom(), '$__timezone') <= base_line.date
ORDER BY base_line.date`;

const MEDIAN_SQL = `
SELECT convert_km((percentile_cont(0.5) WITHIN GROUP (ORDER BY distance))::numeric, '$length_unit') AS dist
FROM drives
WHERE car_id = $car_id AND $__timeFilter(start_date) AND end_date IS NOT NULL`;

// 面板上有三个「Max Speed」：一个跟着时间范围，另两个用了面板级的相对时间（近 30 天、近 7 天，截止到现在）。
// api.batch 只有一个整体范围，所以后两个在 SQL 里直接用 now() 算，合成一条查询
const SPEED_SQL = `
SELECT convert_km(max(speed_max) FILTER (WHERE $__timeFilter(start_date)), '$length_unit') AS max_range,
       convert_km(max(speed_max) FILTER (WHERE start_date >= (now() AT TIME ZONE 'UTC') - interval '30 days'), '$length_unit') AS max_30d,
       convert_km(max(speed_max) FILTER (WHERE start_date >= (now() AT TIME ZONE 'UTC') - interval '7 days'), '$length_unit') AS max_7d
FROM drives
WHERE car_id = $car_id AND end_date IS NOT NULL`;

// 照抄面板：按里程表读数外推。注意 365/12 在 SQL 里是整数除法（= 30），年里程 = 月里程 × 12，
// 为了和 Grafana 一致没有改
const MONTHLY_SQL = `
WITH since AS (
  SELECT timezone('UTC', min(start_date)) AS date FROM drives WHERE car_id = $car_id GROUP BY car_id
)
SELECT convert_km(((max(end_km) - min(start_km)) / greatest(extract(days from (timestamp with time zone $__timeTo() - greatest(timestamp with time zone $__timeFrom(), (SELECT date FROM since)))), 1) * (365/12))::numeric, '$length_unit') AS mileage
FROM drives
WHERE car_id = $car_id AND $__timeFilter(start_date) AND end_date IS NOT NULL
GROUP BY car_id`;

// 速度分布：每个位置点到下一个点的时间算给这个点的车速（10 一档，四舍五入），只看带续航的完整点
// （streaming 推送点续航是空的，和面板一样跳过）。多取一列秒数给提示框用
const HIST_SQL = `
WITH drivedata AS (
  SELECT ROUND(convert_km(p.speed::numeric, '$length_unit') / 10, 0) * 10 AS speed_section,
         EXTRACT(EPOCH FROM (LEAD(p."date") OVER (PARTITION BY p.drive_id ORDER BY p."date") - p."date")) AS seconds_elapsed
  FROM positions p
  WHERE p.car_id = $car_id AND $__timeFilter(p.date) AND p.ideal_battery_range_km IS NOT NULL
)
SELECT speed_section AS speed,
       SUM(seconds_elapsed) * 100 / SUM(SUM(seconds_elapsed)) OVER () AS pct,
       SUM(seconds_elapsed) AS secs
FROM drivedata
WHERE speed_section > 0
GROUP BY speed_section
ORDER BY speed_section`;

// 前 10 个目的地。地名统一用 placeSql（围栏名优先；中文路名和门牌之间不加空格），
// 面板的 exclude 文本框默认为空，只起到「去掉没有名字的地址」的作用，这里照做
const TOP_SQL = `
SELECT name, visited FROM (
  SELECT ${placeSql("g", "a")} AS name, count(*) AS visited
  FROM drives t
  INNER JOIN addresses a ON t.end_address_id = a.id
  LEFT JOIN geofences g ON t.end_geofence_id = g.id
  WHERE t.car_id = $car_id AND $__timeFilter(t.start_date) AND $__timeFilter(t.end_date)
  GROUP BY 1
) d
WHERE name IS NOT NULL AND name <> ''
ORDER BY visited DESC, name
LIMIT 10`;

export async function render(ctx) {
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "chart"]));

  const d = await api.batch(
    { daily: DAILY_SQL, median: MEDIAN_SQL, speed: SPEED_SQL, monthly: MONTHLY_SQL, hist: HIST_SQL, top: TOP_SQL },
    { signal: ctx.signal }
  );

  const days = d.daily;
  const total = days.reduce((s, r) => ({ n: s.n + (r.n || 0), dist: s.dist + (r.dist || 0), energy: s.energy + (r.energy || 0) }), { n: 0, dist: 0, energy: 0 });

  if (!total.n) {
    ui.render(ctx.root, ui.card(ui.empty(`${ctx.range.label}没有完成的行程。`, { icon: "speedometer", title: "没有数据", action: allButton(ctx) })));
    return;
  }

  const nDays = days.length;
  const sp = d.speed[0] || {};
  const monthly = d.monthly[0] ? d.monthly[0].mileage : null;
  const L = fmt.unit.len;
  const hist = d.hist.filter((r) => r.secs > 0);
  const top = d.top;
  const bucket = nDays <= 45 ? "day" : nDays <= 200 ? "week" : "month";
  const trend = groupDays(days, bucket);
  const BUCKET_LABEL = { day: "每天", week: "每周", month: "每月" };
  // 只有一天（比如 r=20260501-20260501）时走势图只有一根柱子，时间轴还会标出 18:00 / 06:00，不画
  const showTrend = trend.length > 1;

  ui.render(
    ctx.root,
    html`
      <div class="pg-ds-stats">${ui.stats([
        { label: "行程次数", value: total.n, unit: "次", sub: `平均每天 ${fmt.num(total.n / nDays, 1)} 次` },
        { label: "总里程", value: fmt.num(total.dist, 0), unit: L, sub: `平均每次 ${fmt.len(total.dist / total.n, 1)}` },
        { label: "总耗电（净）", value: fmt.num(total.energy, total.energy < 100 ? 1 : 0), unit: "kWh", sub: "按掉的续航折算" },
        { label: "单次中位距离", value: fmt.num(d.median[0] && d.median[0].dist, 1), unit: L, sub: "一半的行程比这短" },
        { label: "日均里程", value: fmt.num(total.dist / nDays, 1), unit: L, sub: `按 ${fmt.int(nDays)} 天平均` },
        { label: "日均耗电", value: fmt.num(total.energy / nDays, 2), unit: "kWh", sub: "没开车的天算 0" },
        // 窄屏上小字会换行（见 css），两段各自不拆开
        { label: "最高速度", value: sp.max_range == null ? null : fmt.int(sp.max_range), unit: fmt.unit.speed, sub: html`<span class="pg-ds-nb">近30天 ${fmt.int(sp.max_30d)}</span> · <span class="pg-ds-nb">近7天 ${fmt.int(sp.max_7d)}</span>` },
        { label: "预计年里程", value: monthly == null ? null : fmt.num(monthly * 12, 0), unit: L, sub: `每月约 ${fmt.len(monthly, 0)}` }
      ])}</div>

      <div class="tm-grid-2 pg-ds-cols">
        <div class="tm-stack pg-ds-col">
          ${showTrend &&
          ui.section(
            "里程走势",
            ui.card(ui.chartBox("ds-trend", { height: 220, heightMobile: 190, label: "里程走势" })),
            { sub: `${BUCKET_LABEL[bucket]}开了多远，点柱子看行程次数和耗电` }
          )}
          ${ui.section(
            "速度分布",
            ui.card(
              hist.length
                ? html`${ui.chartBox("ds-hist", { height: 240, heightMobile: 210, label: "各车速档所占的驾驶时间" })}
                    ${histNote(hist)}`
                : ui.empty("这段时间没有可用的车速记录。", { icon: "speedometer" })
            ),
            { sub: `横轴是车速（${fmt.unit.speed}，10 一档），纵轴是占驾驶时间的比例` }
          )}
        </div>
        ${ui.section(
          "常去的地方",
          ui.card(top.length ? topList(top) : ui.empty("这段时间没有记录到目的地。", { icon: "map-marker" }), { pad: !!top.length }),
          { sub: "按到达次数排的前 10 个目的地" }
        )}
      </div>
    `
  );

  await Promise.all([showTrend ? drawTrend(ctx, trend, bucket) : null, hist.length ? drawHist(ctx, hist) : null]);
}

function allButton(ctx) {
  if (ctx.range.key === "all") return null;
  return ui.button("看全部时间", { href: ctx.href("/stats/driving", { r: "all" }), kind: "soft", icon: "calendar-range" });
}

// ---------------------------------------------------------------- 里程走势

// 逐日序列按本地的天 / 周（周一开始）/ 月合并。SQL 里按 $__timezone（浏览器时区）截的天，和这里的本地时间一致
function groupDays(days, kind) {
  const map = new Map();
  for (const r of days) {
    const dt = new Date(r.day);
    let k = r.day;
    if (kind === "week") k = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7)).getTime();
    else if (kind === "month") k = new Date(dt.getFullYear(), dt.getMonth(), 1).getTime();
    let b = map.get(k);
    if (!b) map.set(k, (b = { t: k, first: r.day, last: r.day, n: 0, dist: 0, energy: 0 }));
    b.last = r.day;
    b.n += r.n || 0;
    b.dist += r.dist || 0;
    b.energy += r.energy || 0;
  }
  return [...map.values()];
}

function bucketEnd(t, kind) {
  const dt = new Date(t);
  if (kind === "day") return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1).getTime();
  if (kind === "week") return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 7).getTime();
  return new Date(dt.getFullYear(), dt.getMonth() + 1, 1).getTime();
}

// 首尾两段常常不完整（范围从 9月25日 开始，那个月的柱子只有 6 天），提示框写出实际算了哪几天
function bucketTitle(b, kind) {
  if (kind === "day") return `${fmt.dateAuto(b.t)} ${fmt.weekday(b.t)}`;
  if (kind === "week") return fmt.dateRange(b.first, b.last);
  const whole = b.first === b.t && bucketEnd(b.last, "day") === bucketEnd(b.t, kind);
  return whole ? fmt.month(b.t) : `${fmt.month(b.t)}（${fmt.date(b.first)}–${fmt.date(b.last)}）`;
}

async function drawTrend(ctx, trend, kind) {
  // 柱子画在这一段的正中间，月柱才会落在月份刻度之间而不是压在 1 号上
  const data = trend.map((b) => [(b.t + bucketEnd(b.t, kind)) / 2, +b.dist.toFixed(1)]);
  await chart.create(ctx.root.querySelector("#ds-trend"), {
    // 刻度最细到天：范围只有两三天时 ECharts 会自己标 18:00 / 06:00，对按天的柱子没意义
    xAxis: chart.timeAxis({ min: trend[0].t, max: bucketEnd(trend[trend.length - 1].t, kind), minInterval: DAY }),
    yAxis: chart.valueAxis({ unit: fmt.unit.len }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const b = p && trend[p.dataIndex];
      if (!b) return "";
      return chart.tipHtml(bucketTitle(b, kind), [
        { color: p.color, name: "里程", value: fmt.len(b.dist, b.dist < 100 ? 1 : 0) },
        { name: "行程", value: `${fmt.int(b.n)} 次` },
        { name: "耗电（净）", value: fmt.kwh(b.energy, 1) }
      ]);
    }),
    series: [chart.bars("里程", data, { color: "c1" })]
  });
}

// ---------------------------------------------------------------- 速度分布

function histNote(hist) {
  const peak = hist.reduce((a, b) => (b.pct > a.pct ? b : a), hist[0]);
  const secs = hist.reduce((s, r) => s + r.secs, 0);
  return html`<p class="tm-note pg-ds-note">最常开 <strong class="tm-strong">${fmt.speed(peak.speed)}</strong> 左右，占 ${fmt.pct(peak.pct, 1)}；共统计了 ${hoursText(secs)}的驾驶。</p>`;
}

// 驾驶时间按小时说（「2天5小时」容易被读成日历上的两天）
function hoursText(secs) {
  const h = secs / 3600;
  return h < 1 ? fmt.duration(secs / 60) : `${fmt.num(h, h < 10 ? 1 : 0)} 小时`;
}

async function drawHist(ctx, hist) {
  const u = fmt.unit.speed;
  await chart.create(ctx.root.querySelector("#ds-hist"), {
    // 横轴单位写在分组说明里：放在轴末端的单位在手机上会被裁掉
    xAxis: chart.categoryAxis(hist.map((r) => fmt.num(r.speed))),
    yAxis: chart.valueAxis({ unit: "%" }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const r = p && hist[p.dataIndex];
      if (!r) return "";
      return chart.tipHtml(`${fmt.num(r.speed)} ${u} 左右（${fmt.num(r.speed - 5)}–${fmt.num(r.speed + 5)}）`, [
        { color: p.color, name: "占驾驶时间", value: fmt.pct(r.pct, 1) },
        { name: "累计", value: hoursText(r.secs) }
      ]);
    }),
    series: [chart.bars("占比", hist.map((r) => +r.pct.toFixed(2)), { color: "c1", width: 22 })]
  });
}

// ---------------------------------------------------------------- 前 10 个目的地

function topList(top) {
  const max = top[0].visited;
  return html`<ol class="pg-ds-top">
    ${top.map(
      (r, i) => html`<li>
        <span class="pg-ds-rank${i < 3 ? " is-top" : ""}">${i + 1}</span>
        <div class="pg-ds-top-main">
          <div class="tm-between"><span class="tm-truncate tm-strong" title="${r.name}">${r.name}</span><span class="pg-ds-count tm-num tm-muted tm-small">${fmt.int(r.visited)} 次</span></div>
          ${ui.bar(r.visited, max, "accent")}
        </div>
      </li>`
    )}
  </ol>`;
}
