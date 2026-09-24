// 车辆状态（对应 Grafana「States」面板 xo4BNRkZz）：
//   顶部 = 面板的 Current State / Last state change / parked (%)，另加本范围的休眠占比；
//   状态图 = 面板的 States（state-timeline）。面板是一条横跨整个范围的色带，手机上两天就挤成一条线，
//   这里按天拆成一行一行（横轴 0–24 点），天数多了改成每周 / 每月各状态的占比柱；
//   下面是各状态在范围内的累计时长。
// 状态的算法照抄面板：把行驶 / 充电 / 更新的起止、states 表的在线 / 休眠 / 离线按时间排成一串事件，
// 每个事件的状态一直持续到下一个事件。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { LIVE_SQL } from "./_shared.js";

export const title = "状态";
export const range = { default: "2d" };
export const css = true;

const DAY = 86400e3;

// 面板里的状态码 → 名称、颜色（颜色用各页统一的语义色：行驶蓝、充电绿、更新橙、在线青、休眠紫、离线红）。
// 0 是行驶 / 充电 / 更新结束后回到在线，和 5 一样
const STATES = {
  1: { key: "driving", label: "行驶", color: "c1" },
  2: { key: "charging", label: "充电", color: "c4" },
  6: { key: "updating", label: "更新", color: "c2" },
  5: { key: "online", label: "在线", color: "c5" },
  4: { key: "asleep", label: "休眠", color: "c3" },
  3: { key: "offline", label: "离线", color: "c6" }
};
const ORDER = [1, 2, 6, 5, 4, 3];
const CODE_OF = { online: 5, asleep: 4, offline: 3 };

// 快捷范围：面板默认近 2 天
const QUICK = [
  { value: "1d", label: "1天" },
  { value: "2d", label: "2天" },
  { value: "7d", label: "7天" },
  { value: "30d", label: "30天" }
];

// 按天一行最多画这么多天，再多就改画占比柱（200 天以内每周一根，再长每月一根）
const MAX_LANES = 45;
const MAX_WEEKS_DAYS = 200;

// ---------------------------------------------------------------- SQL

// 面板 Current State / Last state change 是同一条查询
const LAST_SQL = `select start_date, state from states where car_id = $car_id order by start_date desc limit 1`;

// 面板 parked (%)：全部行程时间以外都算停着，不跟时间范围走
const PARKED_SQL = `select 1 - sum(duration_min) / nullif(extract(epoch from (max(end_date) - min(start_date))) / 60, 0) as parked
from drives where car_id = $car_id`;

// 面板 States 的原 SQL（前后各多取 30 天，好知道范围开头那一刻是什么状态）
const EVENTS_SQL = `WITH states AS (
  SELECT
    unnest(ARRAY [start_date + interval '1 second', end_date]) AS date,
    unnest(ARRAY [2, 0]) AS state
  FROM charging_processes
  WHERE
    car_id = $car_id AND
    ($__timeFrom() :: timestamp - interval '30 day') < start_date AND
    (end_date < ($__timeTo() :: timestamp + interval '30 day') OR end_date IS NULL)
  UNION
  SELECT
    unnest(ARRAY [start_date + interval '1 second', end_date]) AS date,
    unnest(ARRAY [1, 0]) AS state
  FROM drives
  WHERE
    car_id = $car_id AND
    ($__timeFrom() :: timestamp - interval '30 day') < start_date AND
    (end_date < ($__timeTo() :: timestamp + interval '30 day') OR end_date IS NULL)
  UNION
  SELECT
    start_date AS date,
    CASE
      WHEN state = 'offline' THEN 3
      WHEN state = 'asleep' THEN 4
      WHEN state = 'online' THEN 5
    END AS state
  FROM states
  WHERE
    car_id = $car_id AND
    ($__timeFrom() :: timestamp - interval '30 day') < start_date AND
    (end_date < ($__timeTo() :: timestamp + interval '30 day') OR end_date IS NULL)
  UNION
  SELECT
    unnest(ARRAY [start_date + interval '1 second', end_date]) AS date,
    unnest(ARRAY [6, 0]) AS state
  FROM updates
  WHERE
    car_id = $car_id AND
    ($__timeFrom() :: timestamp - interval '30 day') < start_date AND
    (end_date < ($__timeTo() :: timestamp + interval '30 day') OR end_date IS NULL)
)
SELECT date AS "time", state
FROM states
WHERE
  date IS NOT NULL AND
  ($__timeFrom() :: timestamp - interval '30 day') < date AND
  date < ($__timeTo() :: timestamp + interval '30 day')
ORDER BY date ASC, state ASC`;

// ---------------------------------------------------------------- 事件 → 状态段

// 每个事件的状态持续到下一个事件（最后一个到现在），相邻同状态合并（面板的 mergeValues），再裁到 [from, to]。
// rawStart / rawEnd 是裁剪前的真实起止，提示框里用；open 是最后那段（还在持续，rawEnd 是现在）
function segments(events, from, to) {
  const raw = [];
  for (let i = 0; i < events.length; i++) {
    const code = events[i].state === 0 ? 5 : events[i].state;
    if (!STATES[code]) continue;
    const a = events[i].time;
    const open = i + 1 >= events.length;
    const b = open ? Date.now() : events[i + 1].time;
    const last = raw[raw.length - 1];
    if (last && last.code === code && last.rawEnd === a) Object.assign(last, { rawEnd: b, open });
    else raw.push({ code, rawStart: a, rawEnd: b, open });
  }
  return raw
    .map((x) => ({ ...x, start: Math.max(x.rawStart, from), end: Math.min(x.rawEnd, to) }))
    .filter((x) => x.end > x.start);
}

function totals(segs) {
  const t = Object.fromEntries(ORDER.map((c) => [c, 0]));
  for (const s of segs) t[s.code] += s.end - s.start;
  return t;
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const quick = QUICK.some((q) => q.value === ctx.range.key) ? ctx.range.key : null;
  ui.render(ctx.root, html`${quickBar(quick)}${ui.skeleton(["stats", "chart"])}`);
  // 委托在 root 上：下面整页重画以后照样管用，加载中点也行
  ui.onSegment(ctx.root, "pg-states-r", (v) => ctx.setQuery({ r: v === ctx.range.defaultKey ? null : v }));

  const d = await api.batch({ last: LAST_SQL, parked: PARKED_SQL, events: EVENTS_SQL, live: LIVE_SQL }, { signal: ctx.signal });

  // 统计到「现在」为止：范围的 to 是下一个整分钟，今天的后半天还没到
  const from = ctx.range.from;
  const to = Math.min(ctx.range.to, Date.now());
  const segs = segments(d.events, from, to);
  const tot = totals(segs);
  const covered = Object.values(tot).reduce((a, b) => a + b, 0);
  const last = d.last[0] || null;
  const kind = chartKind(from, to);

  ui.render(
    ctx.root,
    html`${quickBar(quick)}
      ${summary(ctx, { last, parkedRow: d.parked[0], live: d.live[0] || null, segs, tot, covered })}
      ${covered > 0
        ? html`<div class="pg-states-layout">
            ${ui.section(CHART_TITLE[kind], ui.card(html`${ui.legend(ORDER.filter((c) => tot[c] > 0).map((c) => ({ label: STATES[c].label, color: `var(--tm-${STATES[c].color})` })))}
              <div id="pg-states-chart" class="pg-states-chart" role="img" aria-label="${CHART_TITLE[kind]}"></div>`), {
              sub: kind === "day" ? "横轴是一天的 0 点到 24 点，点一段看起止时间" : "每根柱子是这段时间里各状态所占的比例"
            })}
            ${ui.section("累计时长", ui.card(durationList(tot, covered)), {
              // 写有记录的那一段：范围开头比这辆车的第一条记录还早时（选了「今年」，车是年中才接入的），占比是按有记录的时间算的
              sub: `${period(segs[0].start, segs[segs.length - 1].end)}，共 ${fmt.duration(covered / 60e3)}`
            })}
          </div>`
        : ui.card(
            ui.empty(`${ctx.range.label}没有状态记录。`, {
              icon: "list-status",
              title: "没有状态记录",
              action: !ctx.range.isDefault ? ui.button("看最近 2 天", { kind: "soft", href: ctx.href("/stats/states", { r: null }) }) : null
            })
          )}`
  );

  if (covered > 0) await drawChart(ctx, segs, from, to, kind);
}

// ---------------------------------------------------------------- 快捷范围

// 当前范围不在快捷档里时（页头选了近90天、某个月）没有选中项
function quickBar(value) {
  return html`<div class="pg-states-quick">${ui.segmented("pg-states-r", QUICK, value || "", { label: "时间范围", full: true })}</div>`;
}

// ---------------------------------------------------------------- 顶部统计

function summary(ctx, { last, parkedRow, live, segs, tot, covered }) {
  const code = last ? CODE_OF[last.state] : null;
  const st = code ? STATES[code] : null;
  // 面板的「当前状态」只看 states 表（在线 / 休眠 / 离线），开车、充电时也是「在线」，这里补一句正在做什么。
  // 行驶 / 充电看 LIVE_SQL（和充电页、行程页同一个口径：没有结束记录、又好久没有新记录的是中途断掉，不算正在进行），
  // 点这一格去看那次行程 / 充电；软件更新没有这个问题，还看事件串的最后一段
  const tail = segs[segs.length - 1];
  const doing = live ? (live.kind === "drive" ? "正在行驶" : "正在充电") : tail && tail.open && tail.code === 6 ? "正在更新" : null;
  const parked = parkedRow && parkedRow.parked != null ? parkedRow.parked * 100 : null;
  return ui.stats([
    {
      label: "当前状态",
      icon: "car-side",
      value: st ? st.label : last ? String(last.state) : null,
      tone: code === 5 ? "cyan" : code === 4 ? "violet" : code === 3 ? "red" : null,
      href: live ? ctx.href(`/stats/${live.kind === "drive" ? "drives" : "charges"}/${live.id}`) : null,
      sub: doing || (last ? `已持续 ${fmt.duration((Date.now() - last.start_date) / 60e3)}` : "没有状态记录")
    },
    {
      label: "上次状态变化",
      icon: "clock-outline",
      value: last ? (fmt.day(last.start_date) === "今天" ? fmt.time(last.start_date) : fmt.dateTime(last.start_date)) : null,
      // 一周以内写「3小时前 / 2天前」，再早的 rel 也只是日期，改写星期
      sub: last ? (Date.now() - last.start_date < 7 * DAY ? fmt.rel(last.start_date) : fmt.weekday(last.start_date)) : null
    },
    {
      label: "停车占比",
      icon: "car-clock",
      value: parked != null ? shareNum(parked) : null,
      unit: "%",
      // 面板这一格不跟时间范围走；本范围的停车占比 = 100% − 下面「累计时长」里的行驶占比
      sub: parked != null ? "全部时间" : null
    },
    {
      label: "休眠占比",
      icon: "sleep",
      value: covered > 0 ? shareNum((tot[4] / covered) * 100) : null,
      unit: "%",
      // 「本范围 · 290天19小时」320 宽放不下：整项藏掉时长（下面「累计时长」里有），不截成半截
      sub: covered > 0 ? ui.fit(["本范围", fmt.duration(tot[4] / 60e3)], { sep: true }) : null
    }
  ]);
}

// 占比取整（各页统一；p 是百分数）：会四舍五入成「0%」的写「<1」，会四舍五入成「100%」的写「>99」，
// 免得休眠了 99.6% 的写成「100%」、更新了 55 分钟的写成「0%」
function shareNum(p) {
  return p > 0 && p < 0.5 ? "<1" : p >= 99.5 && p < 100 ? ">99" : fmt.num(p, 0);
}

// ---------------------------------------------------------------- 累计时长

function durationList(tot, covered) {
  const rows = ORDER.filter((c) => tot[c] > 0).sort((a, b) => tot[b] - tot[a]);
  const max = Math.max(...rows.map((c) => tot[c]));
  return html`<div class="pg-states-list">${rows.map((c) => {
    const s = STATES[c];
    const share = (tot[c] / covered) * 100;
    return html`<div class="pg-states-item is-${s.key}">
      <div class="pg-states-item-head">
        <span class="pg-states-item-name"><i></i>${s.label}</span>
        <span class="tm-num"><b>${fmt.duration(tot[c] / 60e3)}</b><span class="tm-muted"> · ${shareNum(share)}%</span></span>
      </div>
      <div class="pg-states-bar"><span style="width:${((tot[c] / max) * 100).toFixed(2)}%"></span></div>
    </div>`;
  })}</div>`;
}

// ---------------------------------------------------------------- 图表

const CHART_TITLE = { day: "每天的状态", week: "每周各状态占比", month: "每月各状态占比" };

// day：按天一行的状态条；week / month：每周 / 每月一根占比柱
function chartKind(from, to) {
  return chart.bucketKind(from, to, { day: MAX_LANES, week: MAX_WEEKS_DAYS });
}

function laneLabel(day) {
  const t = fmt.day(day);
  return t === "今天" || t === "昨天" ? t : `${new Date(day).getMonth() + 1}/${new Date(day).getDate()} ${fmt.weekday(day)}`;
}

// 两头都带日期的时间段（fmt.period：「9月21日 23:06–次日 02:52」「9月21日 14:05 – 9月23日 08:00」）。
// open（还在持续）时结束写「现在」：不管开始了多久都是「9月21日 14:05–现在」，「现在」不是日期时间，不加空格
function period(a, b, open) {
  return open ? `${fmt.dateTime(a)}–现在` : fmt.period(a, b);
}

async function drawChart(ctx, segs, from, to, kind) {
  const el = ctx.root.querySelector("#pg-states-chart");
  if (kind === "day") await drawLanes(el, segs, from, to);
  else await drawShares(el, segs, kind, to);
}

// 按天一行：状态段在午夜切开，横轴是一天里的小时（0–24）
async function drawLanes(el, segs, from, to) {
  // 最新的一天在最上面（和时间线一样倒序）
  const days = [];
  for (let d = chart.bucketOf(from); d < to; d = chart.bucketEnd(d)) days.unshift(d);
  const n = days.length;
  const laneOf = new Map(days.map((d, i) => [d, i]));
  const items = [];
  for (const s of segs) {
    let a = s.start;
    while (a < s.end) {
      const d0 = chart.bucketOf(a);
      const b = Math.min(s.end, chart.bucketEnd(d0));
      const lane = laneOf.get(d0);
      if (lane != null) {
        items.push({ lane, start: (a - d0) / 3600e3, end: (b - d0) / 3600e3, color: STATES[s.code].color, name: STATES[s.code].label, raw: s });
      }
      a = b;
    }
  }
  // 天数少时每行高一点；另外 36px 是图表默认的上边距和底下 0:00–24:00 那行刻度
  const laneH = n <= 2 ? 34 : n <= 7 ? 26 : n <= 14 ? 20 : 15;
  el.style.height = `${n * laneH + 36}px`;

  await chart.create(el, {
    xAxis: chart.valueAxis({
      min: 0,
      max: 24,
      fmt: (v) => `${v}:00`,
      splitLine: { show: true, lineStyle: { color: "@line" } },
      axisLine: { show: false }
    }),
    yAxis: chart.categoryAxis(days.map(laneLabel), {
      inverse: true,
      axisLine: { show: false },
      splitLine: { show: false },
      axisLabel: { interval: n > 14 ? "auto" : 0 }
    }),
    series: [
      chart.timelineSeries(items, {
        name: "状态",
        height: n <= 7 ? 0.62 : 0.74,
        // 横轴是一天里的小时，提示框写整段（不是午夜切开后的这一截）的真实起止
        tooltip: (it, p) =>
          chart.tipHtml(it.name, [
            { name: period(it.raw.rawStart, it.raw.rawEnd, it.raw.open), value: "" },
            { color: p.color, name: "时长", value: fmt.duration((it.raw.rawEnd - it.raw.rawStart) / 60e3) }
          ])
      })
    ]
  });
}

// 天数多：每周 / 每月一根柱，各状态占这段时间的百分比（堆叠到 100%）
async function drawShares(el, segs, kind, to) {
  const buckets = new Map();
  for (const s of segs) {
    let a = s.start;
    while (a < s.end) {
      const k = chart.bucketOf(a, kind);
      const b = Math.min(s.end, chart.bucketEnd(k, kind));
      const t = buckets.get(k) || Object.fromEntries(ORDER.map((c) => [c, 0]));
      t[s.code] += b - a;
      buckets.set(k, t);
      a = b;
    }
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  el.style.height = "260px";
  const used = ORDER.filter((c) => keys.some((k) => buckets.get(k)[c] > 0));
  await chart.create(el, {
    legend: { show: false },
    // 从有记录的第一根柱子画起（车是范围中间才接入的，前面不留一片空白）
    xAxis: chart.bucketAxis(kind, keys[0], to),
    yAxis: chart.valueAxis({ min: 0, max: 100, fmt: (v) => `${v}%` }),
    tooltip: chart.tooltip((ps) => {
      const list = Array.isArray(ps) ? ps : [ps];
      return chart.tipHtml(
        chart.bucketTitle(list[0].value[2], kind),
        list.filter((p) => p.value[1] > 0).map((p) => ({ color: p.color, name: p.seriesName, value: `${shareNum(p.value[1])}%` }))
      );
    }),
    series: used.map((c) =>
      chart.bars(
        STATES[c].label,
        keys.map((k) => {
          const t = buckets.get(k);
          const sum = Object.values(t).reduce((a, b) => a + b, 0);
          return [chart.bucketMid(k, kind), sum > 0 ? +((t[c] / sum) * 100).toFixed(2) : 0, k];
        }),
        { color: STATES[c].color, stack: "s", width: kind === "month" ? 22 : 12 }
      )
    )
  });
}
