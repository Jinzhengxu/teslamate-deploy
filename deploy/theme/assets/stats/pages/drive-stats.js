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

// 面板上有三个「Max Speed」，SQL 一样：一个跟着时间范围，另两个用了面板级的相对时间（近 30 天、近 7 天，截止到现在）。
// 后两个用单条查询自己的 range，和同一个 batch 并发发出
const SPEED_SQL = `
SELECT convert_km(max(speed_max), '$length_unit') AS speed
FROM drives
WHERE car_id = $car_id AND $__timeFilter(start_date) AND end_date IS NOT NULL`;

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

// 里程：≥ 100 取整，< 100 保留 1 位
const lenD = (v) => (v != null && Math.abs(v) >= 100 ? 0 : 1);

export async function render(ctx) {
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "chart"]));

  // 近 30 天 / 近 7 天截止到现在（取整到分钟才命中缓存），和面板的 timeFrom 一样不跟着页面范围变
  const now = Math.ceil(Date.now() / 60e3) * 60e3;
  const d = await api.batch(
    {
      daily: DAILY_SQL,
      median: MEDIAN_SQL,
      speed: SPEED_SQL,
      speed30: { sql: SPEED_SQL, range: { from: now - 30 * DAY, to: now } },
      speed7: { sql: SPEED_SQL, range: { from: now - 7 * DAY, to: now } },
      monthly: MONTHLY_SQL,
      hist: HIST_SQL,
      top: TOP_SQL
    },
    { signal: ctx.signal }
  );

  const days = d.daily;
  const total = days.reduce((s, r) => ({ n: s.n + (r.n || 0), dist: s.dist + (r.dist || 0), energy: s.energy + (r.energy || 0) }), { n: 0, dist: 0, energy: 0 });

  if (!total.n) {
    ui.render(ctx.root, ui.card(ui.empty(`${ctx.range.label}没有完成的行程。`, { icon: "speedometer", title: "没有行程", action: allButton(ctx) })));
    return;
  }

  const nDays = days.length;
  const maxOf = (rows) => (rows[0] ? rows[0].speed : null);
  const monthly = d.monthly[0] ? d.monthly[0].mileage : null;
  const median = d.median[0] ? d.median[0].dist : null;
  const L = fmt.unit.len;
  const hist = d.hist.filter((r) => r.secs > 0);
  const top = d.top;
  // 从有数据的第一天画到范围终点。门槛沿用原来的：45 天以内按天，200 天以内按周，再长按月（近 1 年 = 13 根月柱）
  const span = { from: days[0].day, to: ctx.range.to };
  const kind = chart.bucketKind(span.from, span.to, { day: 45, week: 200 });
  const trend = groupDays(days, kind);
  const BUCKET_LABEL = { day: "每天", week: "每周", month: "每月" };
  // 只有一天（比如 r=20260501-20260501）时走势图只有一根柱子，不画
  const showTrend = trend.length > 1;
  const avgDist = total.dist / total.n;
  const dayDist = total.dist / nDays;

  ui.render(
    ctx.root,
    html`
      ${ui.stats([
        { label: "行程次数", icon: "map-marker-path", value: total.n, unit: "次", sub: `平均每天 ${fmt.num(total.n / nDays, 1)} 次` },
        { label: "总里程", icon: "road-variant", value: total.dist, digits: lenD(total.dist), unit: L, sub: `平均每次 ${fmt.len(avgDist, lenD(avgDist))}` },
        { label: "总耗电（净）", icon: "lightning-bolt", value: total.energy, digits: 1, unit: "kWh", sub: "按掉的续航折算" },
        { label: "单次中位距离", icon: "map-marker-distance", value: median, digits: lenD(median), unit: L, sub: "一半的行程比这短" },
        { label: "日均里程", icon: "road-variant", value: dayDist, digits: lenD(dayDist), unit: L, sub: `按 ${fmt.int(nDays)} 天平均` },
        { label: "日均耗电", icon: "lightning-bolt", value: total.energy / nDays, digits: 1, unit: "kWh", sub: "没开车的天算 0" },
        {
          label: "最高速度",
          icon: "speedometer",
          value: maxOf(d.speed),
          unit: fmt.unit.speed,
          sub: ui.segs([`近30天 ${fmt.int(maxOf(d.speed30))}`, `近7天 ${fmt.int(maxOf(d.speed7))}`])
        },
        {
          label: "预计年里程",
          icon: "road-variant",
          value: monthly == null ? null : monthly * 12,
          digits: lenD(monthly * 12),
          unit: L,
          sub: monthly == null ? null : `每月约 ${fmt.len(monthly, lenD(monthly))}`
        }
      ])}

      <div class="tm-grid-2 pg-ds-grid">
        ${showTrend &&
        ui.section("里程走势", ui.card(ui.chartBox("ds-trend", { height: 220, heightMobile: 190, label: "里程走势" })), {
          sub: `${BUCKET_LABEL[kind]}开了多远，点柱子看行程次数和耗电`
        })}
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
        ${ui.section(
          "常去的地方",
          ui.card(
            top.length
              ? ui.rank(top.map((r) => ({ name: r.name, value: r.visited })), { unit: "次", shown: 0 })
              : ui.empty("这段时间没有记录到目的地。", { icon: "map-marker" })
          ),
          { sub: "按到达次数排的前 10 个目的地", id: "pg-ds-top" }
        )}
      </div>
    `
  );

  await Promise.all([showTrend ? drawTrend(ctx, trend, kind, span) : null, hist.length ? drawHist(ctx, hist) : null]);
}

function allButton(ctx) {
  if (ctx.range.key === "all") return null;
  return ui.button("查看全部时间", { href: ctx.href("/stats/driving", { r: "all" }), kind: "soft" });
}

// 占比：取整；不到 1% 的档写「<1%」，免得显示成 0%
function share(v) {
  return v > 0 && v < 0.5 ? "<1%" : fmt.pct(v);
}

// ---------------------------------------------------------------- 里程走势

// 逐日序列按本地的天 / 周（周一开始）/ 月合并。SQL 里按 $__timezone（浏览器时区）截的天，和这里的本地时间一致
function groupDays(days, kind) {
  const map = new Map();
  for (const r of days) {
    const k = chart.bucketOf(r.day, kind);
    let b = map.get(k);
    if (!b) map.set(k, (b = { t: k, first: r.day, last: r.day, n: 0, dist: 0, energy: 0 }));
    b.last = r.day;
    b.n += r.n || 0;
    b.dist += r.dist || 0;
    b.energy += r.energy || 0;
  }
  return [...map.values()];
}

// 首尾两段常常不完整（范围从 9月25日 开始，那个月的柱子只有 6 天），提示框写出实际算了哪几天
function trendTitle(b, kind) {
  if (kind === "day") return chart.bucketTitle(b.t, kind);
  if (kind === "week") return fmt.dateRange(b.first, b.last);
  const whole = b.first === b.t && chart.bucketEnd(b.last, "day") === chart.bucketEnd(b.t, kind);
  return whole ? chart.bucketTitle(b.t, kind) : `${chart.bucketTitle(b.t, kind)}（${fmt.dateRange(b.first, b.last)}）`;
}

async function drawTrend(ctx, trend, kind, span) {
  await chart.create(ctx.root.querySelector("#ds-trend"), {
    // 轴的右端是最后一个桶的结束点（下个月 1 号、下周一），还没到，不标字：不然两头都写「10月」
    xAxis: chart.bucketAxis(kind, span.from, span.to, { axisLabel: { showMaxLabel: false } }),
    yAxis: chart.valueAxis({ unit: fmt.unit.len }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const b = p && trend[p.dataIndex];
      if (!b) return "";
      return chart.tipHtml(trendTitle(b, kind), [
        { color: p.color, name: "里程", value: fmt.len(b.dist, lenD(b.dist)) },
        { name: "行程", value: `${fmt.int(b.n)} 次` },
        { name: "耗电（净）", value: fmt.kwh(b.energy, 1) }
      ]);
    }),
    series: [chart.bars("里程", trend.map((b) => [chart.bucketMid(b.t, kind), +b.dist.toFixed(1)]), { color: "c1" })]
  });
}

// ---------------------------------------------------------------- 速度分布

function histNote(hist) {
  const peak = hist.reduce((a, b) => (b.pct > a.pct ? b : a), hist[0]);
  const secs = hist.reduce((s, r) => s + r.secs, 0);
  return html`<p class="tm-note pg-ds-note">最常开 <strong class="tm-strong">${fmt.speed(peak.speed)}</strong> 左右，占 ${share(peak.pct)}；<span class="pg-ds-nb">共统计了 ${hoursText(secs)}的驾驶。</span></p>`;
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
        { color: p.color, name: "占驾驶时间", value: share(r.pct) },
        { name: "累计", value: hoursText(r.secs) }
      ]);
    }),
    series: [chart.bars("占比", hist.map((r) => +r.pct.toFixed(2)), { color: "c1", width: 22 })]
  });
}
