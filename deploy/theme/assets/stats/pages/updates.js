// 软件更新（对应 Grafana「Updates」面板 IiC07mgWz）：
//   顶部 = 面板的 Updates（次数）、Median time between updates，另加当前版本、平均安装用时；
//   折线 = 表格里 Ø Rated range 那一列画成图（每个版本用着的那段时间，平均满电续航是多少）；
//   表格 = 面板的 Updates 表：版本、安装时间、用时、距上一次、期间充电次数、期间平均满电续航。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";

export const title = "软件更新";
export const range = { default: "all" };
export const css = true;

// ---------------------------------------------------------------- SQL

// 面板 Updates（stat）
const COUNT_SQL = `SELECT count(*) as n, avg(extract(epoch from end_date - start_date)) as avg_sec, max(extract(epoch from end_date - start_date)) as max_sec
FROM updates
WHERE $__timeFilter(start_date) AND car_id = $car_id`;

// 面板 Median time between updates（秒）
const MEDIAN_SQL = `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY since_last_update) as median_sec FROM (
  SELECT extract(EPOCH FROM start_date - lag(start_date) OVER (ORDER BY start_date)) AS since_last_update
  FROM updates
  WHERE $__timeFilter(start_date) AND car_id = $car_id
) d`;

// 当前版本：最近一次更新装上的版本，不跟时间范围走
const CURRENT_SQL = `select version, start_date from updates where car_id = $car_id order by start_date desc limit 1`;

// 面板 Updates 表的原 SQL。改动：多取 id、结束时间、完整版本号；「距上一次」除了面板的 age（「1 mon 6 days」），
// 另外按本地日期算天数（面板用的是 UTC 日期，凌晨装的更新会算到前一天，天数差通常一样）
const TABLE_SQL = `with u as (
  select *, coalesce(lag(start_date) over(order by start_date desc), now()) as next_start_date
  from updates
  where car_id = $car_id and $__timeFilter(start_date)
),
rng as (
  SELECT
    date_trunc('hour', timezone('UTC', date), '$__timezone') AS date,
    (sum(\${preferred_range}_battery_range_km)/ nullif(sum(usable_battery_level),0) * 100 ) AS "battery_rng",
    sum(case when action = 'Charge' then 1 else 0 end) as chg_ct
  FROM (
    select usable_battery_level, start_date as date, start_rated_range_km as rated_battery_range_km, start_ideal_range_km as ideal_battery_range_km, 'Drive' as action
    from drives d
    inner join positions p on d.start_position_id = p.id
    where d.car_id = $car_id and $__timeFilter(start_date) and usable_battery_level > 0
    union all
    select end_battery_level as usable_battery_level, end_date, end_rated_range_km as rated_battery_range_km, end_ideal_range_km as ideal_battery_range_km, 'Charge' as action
    from charging_processes p
    where $__timeFilter(end_date) and p.car_id = $car_id
  ) as data
  GROUP BY 1
)
select
  u.id, u.start_date, u.end_date,
  extract(epoch from u.end_date - u.start_date) as update_duration,
  age(date(u.start_date), date(lag(u.start_date) over (order by u.start_date))) as since_last_update,
  date(timezone('$__timezone', timezone('UTC', u.start_date)))
    - date(timezone('$__timezone', timezone('UTC', lag(u.start_date) over (order by u.start_date)))) as days_since,
  split_part(u.version, ' ', 1) as version,
  u.version as version_full,
  sum(r.chg_ct) as chg_ct,
  convert_km(avg(r.battery_rng), '$length_unit')::numeric(6,2) as avg_range
from u u
left join rng r on r.date between u.start_date and u.next_start_date
group by u.id, u.car_id, u.start_date, u.end_date, next_start_date, split_part(u.version, ' ', 1), u.version
order by u.start_date desc`;

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "list"]));

  const d = await api.batch(
    { count: COUNT_SQL, median: MEDIAN_SQL, current: CURRENT_SQL, table: TABLE_SQL },
    { signal: ctx.signal }
  );

  const c = d.count[0] || {};
  const rows = d.table;
  const cur = d.current[0] || null;

  if (!rows.length) {
    ui.render(
      ctx.root,
      html`${ui.stats([currentStat(cur), { label: "更新次数", icon: "update", value: 0, unit: "次", sub: ctx.range.label }], { cols: 2 })}
        ${ui.card(
          ui.empty(cur ? `${ctx.range.label}没有软件更新记录。` : "TeslaMate 还没有记录到这辆车的软件更新。", {
            icon: "update",
            title: "没有更新记录",
            action: ctx.range.key !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/updates", { r: null }) }) : null
          })
        )}`
    );
    return;
  }

  const median = d.median[0] ? d.median[0].median_sec : null;
  const latestInRange = rows[0];
  const withRange = rows.filter((r) => r.avg_range != null);

  ui.render(
    ctx.root,
    html`
      ${ui.stats([
        currentStat(cur),
        { label: "更新次数", icon: "update", value: c.n, unit: "次", sub: `最近一次 ${fmt.rel(latestInRange.start_date)}` },
        {
          // 标签别写成「更新间隔（中位数）」：320 宽的屏上一格放不下，会被截成「更新间隔（…」
          label: "更新间隔",
          icon: "calendar-range",
          // 面板显示成「5.7 weeks」这种，国内习惯按天说
          value: median != null ? median / 86400 : null,
          digits: median != null && median < 10 * 86400 ? 1 : 0,
          unit: "天",
          sub: median != null ? "中位数" : "至少要两次更新"
        },
        {
          label: "平均安装用时",
          icon: "timer-outline",
          value: c.avg_sec != null ? fmt.duration(c.avg_sec / 60) : null,
          sub: c.max_sec != null ? `最长 ${fmt.duration(c.max_sec / 60)}` : null
        }
      ])}
      ${withRange.length >= 2
        ? ui.section(
            "各版本期间的满电续航",
            ui.card(ui.chartBox("pg-updates-chart", { height: 220, heightMobile: 200, label: "各版本期间的平均满电续航" })),
            { sub: "从装上这个版本到下一次更新之间，按电量折算的满电续航平均值" }
          )
        : ""}
      ${ui.section(
        "更新记录",
        ui.card(
          ui.table({
            columns: [
              { key: "version", label: "版本", primary: true, fmt: (v, r) => versionCell(v, r) },
              { key: "start_date", label: "安装时间", fmt: (v) => fmt.dateTime(v) },
              { key: "update_duration", label: "用时", align: "right", fmt: (v) => (v != null ? fmt.duration(v / 60) : "没有结束记录") },
              { key: "days_since", label: "距上一次", align: "right", fmt: (v, r) => sinceCell(v, r) },
              { key: "chg_ct", label: "期间充电", align: "right", fmt: (v) => (v != null ? `${fmt.int(v)} 次` : "0 次") },
              { key: "avg_range", label: "期间满电续航", align: "right", fmt: (v) => fmt.len(v, 0) }
            ],
            rows
          }),
          { pad: false }
        ),
        { sub: "「期间」指从这次更新到下一次更新（或现在）之间；点版本号看更新说明（notateslaapp.com）" }
      )}
    `
  );

  if (withRange.length >= 2) await drawChart(ctx, withRange);
}

function currentStat(cur) {
  const v = cur ? shortVersion(cur.version) : null;
  return {
    label: "当前版本",
    icon: "car-electric-outline",
    value: v,
    // 「9月12日安装 · 12天前」，一行放不下时（320 宽、去年装的带年份）整项藏掉后一项，不截成半截
    sub: cur ? ui.fit([`${fmt.dateAuto(cur.start_date)}安装`, daysAgo(cur.start_date)], { sep: true }) : "没有更新记录"
  };
}

// 「今天 / 昨天 / 12天前」：fmt.rel 超过一周就只给日期，和前面的安装日期重复了（写法和 fmt.rel 一样不加空格）
function daysAgo(ms) {
  const d = new Date(ms);
  const now = new Date();
  const n = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400e3);
  return n <= 0 ? "今天" : n === 1 ? "昨天" : `${n}天前`;
}

// ---------------------------------------------------------------- 表格单元格

// 「2026.32.1 429934134f」→「2026.32.1」（面板也是取空格前面那段）
function shortVersion(v) {
  return v ? String(v).split(" ")[0] : null;
}

// 版本号只放行「数字.数字…」这种，别把数据库里的任意文本拼进链接
function releaseNotes(v) {
  return v && /^\d{4}\.\d{1,3}(\.\d{1,3}){0,3}$/.test(v) ? `https://www.notateslaapp.com/software-updates/version/${v}/release-notes` : null;
}

function versionCell(v, r) {
  const url = releaseNotes(v);
  const hash = r.version_full && r.version_full !== v ? String(r.version_full).slice(String(v).length).trim() : "";
  return html`<span class="pg-updates-ver">${url
    ? html`<a href="${url}" target="_blank" rel="noopener" title="更新说明">${v}${ui.icon("open-in-new", { cls: "pg-updates-ext" })}</a>`
    : v}${hash ? html`<span class="pg-updates-hash">${hash}</span>` : ""}</span>`;
}

// 「36 天」，悬停看面板原来的写法（1 mon 5 days）
function sinceCell(days, r) {
  if (days == null) return "第一次";
  return html`<span title="${r.since_last_update || ""}">${fmt.int(days)} 天</span>`;
}

// ---------------------------------------------------------------- 图表

async function drawChart(ctx, rows) {
  const data = rows
    .slice()
    .sort((a, b) => a.start_date - b.start_date)
    .map((r) => [r.start_date, +r.avg_range, r.version, r.chg_ct, r.start_date]);
  // 版本号标签：点多了或者手机上放不下，就只在提示框里看
  const labels = data.length <= 12 && !window.matchMedia("(max-width: 480px)").matches;
  // 每个点的值管到下一次更新为止（阶梯线）；最后一个版本一直用到现在，补一个不画圆点的终点把线拉到今天。
  // 看往年的范围时只拉到范围结束：之后换没换版本不归这个范围管，拉到今天横轴会多出一大段范围外的时间。
  // 阶梯在下一个点处竖着落下来：续航比上一版低时标签放点的下面，放上面会压在上一段的横线上
  const tail = data[data.length - 1];
  const end = Math.min(Date.now(), ctx.range.to);
  const series = data.map((x, i) => ({ value: x, label: { position: i > 0 && x[1] < data[i - 1][1] ? "bottom" : "top" } }));
  // 第 5 列是安装时间：补的终点横坐标是「现在」（或范围结束），提示框里不能写成那天装的
  if (end > tail[0]) series.push({ value: [end, tail[1], tail[2], tail[3], tail[4]], symbol: "none", label: { show: false } });
  const [lo, hi] = rangeBounds(data.map((x) => x[1]), labels ? 4 : 1);
  await chart.create(ctx.root.querySelector("#pg-updates-chart"), {
    // 左右各留一点，第一个点的版本号标签不压在纵轴刻度上
    xAxis: chart.timeAxis({ min: (v) => v.min - (v.max - v.min) * 0.05, max: (v) => v.max + (v.max - v.min) * 0.01 }),
    yAxis: chart.valueAxis({ unit: fmt.unit.len, min: lo, max: hi }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const [, v, ver, n, at] = p.value;
      return chart.tipHtml(`${ver}（${fmt.dateAuto(at)} 装上）`, [
        { color: p.color, name: "平均满电续航", value: fmt.len(v, 0) },
        { name: "期间充电", value: `${n ?? 0} 次` }
      ]);
    }),
    series: [
      {
        ...chart.line("满电续航", series, { color: "c1", symbol: true, step: "end" }),
        symbolSize: 7,
        label: { show: labels, position: "top", color: "@text-2", fontSize: 11, formatter: (p) => p.value[2] },
        // 两次更新隔得近（隔一两周）时版本号会叠成一团：叠上的藏掉后一个，指到那个点时还会显示，提示框里也有
        labelLayout: { hideOverlap: true }
      }
    ]
  });
}

// 纵轴刻度间隔的候选（km），从小到大试
const Y_STEPS = [5, 10, 20, 25, 50, 100];

// 纵轴上下限：续航只差几十公里，从 0 画起就是一条平线，所以贴着数据、上下留 pad（有标签时要放得下版本号）。
// 先定刻度间隔再取整：只把上下限取到 5 的倍数的话，差 35 km 这种分不成 3–6 格，核心挑不出间隔，
// ECharts 会画出 560 / 570 / 580 / 590 / 595 这种最后一格只有一半的刻度。
// 取第一个分出来不超过 6 格的间隔；不到 3 格时往留白少的一头补满 3 格（只有两格的话核心按 4 等分，
// 会挑出 537.5 这种带小数的刻度）。上下限之差正好是间隔的 3–6 倍，核心总能等分
function rangeBounds(vals, pad) {
  const min = Math.min(...vals) - pad;
  const max = Math.max(...vals) + pad;
  const step = Y_STEPS.find((s) => Math.ceil(max / s) - Math.floor(min / s) <= 6) || Y_STEPS[Y_STEPS.length - 1];
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  while (hi - lo < 3 * step) {
    if (hi - max <= min - lo) hi += step;
    else lo -= step;
  }
  return [lo, hi];
}
