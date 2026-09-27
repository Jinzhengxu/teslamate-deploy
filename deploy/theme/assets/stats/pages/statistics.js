// 按天 / 周 / 月 / 年汇总（对应 Grafana 面板 Statistics，1EZnXszMk）
//
// 面板是一张表，由四条查询按周期（date）拼起来：
//   A 行程：驾驶时长、里程（里程表读数差）、平均气温、行程次数、续航达成率
//   B 充电：充电量（从电网取）、充入电量、费用、充电次数
//   C 净能耗：行驶时的续航差 × 车辆能效 ÷ 行驶距离
//   D 毛能耗：把行程和充电的起止串成一条时间线，相邻两点之间掉的续航（停车掉电、空调都算）÷ 里程表走的距离
// 再用 transformations 算出 元/度、元/百公里、额外损耗（1 − 净 / 毛）。这里 SQL 照抄，派生列在 JS 里按同样的公式算。
// 和面板不一样的地方：
//   - D：面板按「周期 + 是否不完整」分组，同一个月有未完成的行程 / 充电时会拆成两行（Grafana 表格里真会出现两行「2026 July」），
//     这里按周期合成一行；
//   - D：面板的「是否不完整」是开窗累计的（出现过一次未完成记录，之后所有周期都算不完整），这里只看这个周期里有没有，
//     而且只算中途断掉的（正在充电 / 行驶的那一次单独标出来，见 _shared.js）；
//   - A、B：没结束的行程和充电（正在进行的、中途断掉的）不算进次数。面板把它们也算进去（充电量是空的，「平均每次」被摊薄），
//     点次数进到充电、行程列表，那边的合计又不算它们，两边的次数对不上。中途断掉的另外数出来，周期里只有它们时写明，
//     不然会写成「没有充电」，和同一张卡片上的「数据不全」对不上。
// 面板的 high_precision（按位置点算毛能耗）用默认的「否」。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { driveStateSql, chargeStateSql, LIVE_SQL, statePill } from "./_shared.js";
import { lenDigits, lenText } from "./_drive-item.js";

export const title = "按月汇总";
// 按天默认只看近 30 天（一年 365 根柱子太挤），别的周期看近 1 年
export const range = { default: (q) => (q.get("period") === "day" ? "30d" : "1y") };
export const css = true;

const PERIODS = [
  { value: "day", label: "按天", unit: "天", noun: "天" },
  { value: "week", label: "按周", unit: "周", noun: "周" },
  { value: "month", label: "按月", unit: "月", noun: "个月" },
  { value: "year", label: "按年", unit: "年", noun: "年" }
];

// 图表可以切换的指标
const METRICS = [
  { value: "distance", label: "里程" },
  { value: "cons", label: "能耗" },
  { value: "used", label: "充电量" },
  { value: "cost", label: "花费" }
];

// 明细先画 50 个周期，「再显示」往下加（按天看一年有 365 个）
const PAGE = 50;
// 柱子超过这么多就加缩放，默认显示最近的这些
const ZOOM_BARS = 60;
// 这个宽度以上明细是表格：九列在平板宽度下放不下，只能横着滚，不如卡片好看
const WIDE = "(min-width: 1024px)";

// 页面底部的说明（拼成一段，别在中文句子中间留下源码换行变成的空格）
const FOOT = [
  "里程按里程表读数算，包括 TeslaMate 没记录到的行驶。",
  "能耗（净）只算开车时用掉的电；能耗（毛）按两次充电之间掉的续航算，停车掉电、开空调都在里面，「额外」是多出来的比例。",
  "充电量是从电网取的电（含充电损耗），元/度按它算；每百公里的费用 = 毛能耗 × 充进电池的每度电价格。",
  "续航达成率 = 实际开的距离 ÷ 表显续航减少的里程。"
];
const FOOT_BROKEN = "标了「数据不全」的周期里有没结束的行程或充电（TeslaMate 中途停过），不计入次数，能耗可能有偏差。";
const FOOT_LIVE = "正在充电 / 行驶的那一次还没结束，结束后才计入。";

const lenWord = () => (fmt.unit.len === "mi" ? "英里" : "公里");

// 切换指标只重画图表，不进 URL；记在模块里，换周期、换范围重画页面时还是同一个指标
let metricPref = "distance";

// ---------------------------------------------------------------- SQL（改编自面板，列名换成页面用的）

// A + C：面板的 A、C 两条都是按行程开始时间分组，合成一条；多取 energy（净耗电 kWh）和 logged（行程距离之和），
// 给「耗电」一格和顶部的合计用。
// 没结束的行程也查出来，只是不算进次数：TeslaMate 结束时才一起写距离、里程表、续航这些列，没结束的这几列都是空的，
// sum / avg / max / min 本来就跳过；中途断掉的单独数出来（broken_drives）
const DRIVES_SQL = `select
  date_trunc('$period', timezone('UTC', d.start_date), '$__timezone') as date,
  sum(d.duration_min) as duration,
  convert_km(max(d.end_km)::numeric - min(d.start_km)::numeric, '$length_unit') as distance,
  convert_celsius(avg(d.outside_temp_avg), '$temp_unit') as temp,
  count(*) filter (where d.end_date is not null) as drives,
  count(*) filter (where ${driveStateSql("d")} = 'incomplete') as broken_drives,
  case when sum(d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) > 0
    then sum(d.distance) / sum(d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) end as efficiency,
  sum((d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency) as energy,
  convert_km(sum(d.distance)::numeric, '$length_unit') as logged,
  sum((d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency * 1000)
    / nullif(convert_km(sum(d.distance)::numeric, '$length_unit'), 0) as cons_net
from drives d
join cars c on c.id = d.car_id
where d.car_id = $car_id and $__timeFilter(d.start_date)
group by 1`;

// 顶部合计的里程：整段时间的里程表读数差。不能把每个周期的加起来 —— 周期之间的空档（比如 TeslaMate
// 停机时跨过零点的那趟）会被漏掉，按天看比按月看少几十公里，和「包括没记录到的行驶」的说明对不上
const SPAN_SQL = `select convert_km(max(end_km)::numeric - min(start_km)::numeric, '$length_unit') as distance
from drives
where car_id = $car_id and $__timeFilter(start_date) and end_date is not null`;

// B：和面板一样，充进 0 kWh 的不算。没结束的充电和上面的行程一样处理：充电量、费用这些结束时才写，
// 查出来也不影响合计，只是次数只数结束了的，中途断掉的单独数出来（broken_charges）
const CHARGES_SQL = `select
  date_trunc('$period', timezone('UTC', cp.start_date), '$__timezone') as date,
  sum(greatest(cp.charge_energy_added, cp.charge_energy_used)) as used,
  sum(cp.charge_energy_added) as added,
  sum(cp.cost) as cost,
  count(*) filter (where cp.end_date is not null) as charges,
  count(*) filter (where ${chargeStateSql("cp")} = 'incomplete') as broken_charges
from charging_processes cp
where cp.car_id = $car_id and $__timeFilter(cp.start_date)
  and (cp.charge_energy_added is null or cp.charge_energy_added > 0)
group by 1`;

// D：面板说这条和充电统计、能耗、旅程几个面板共用。续航差和距离都返回出来，合计时按总和再除。
// incomplete（没有结束记录，这一段不算）照面板；broken 是其中中途断掉的，给「数据不全」标签用
const GROSS_SQL = `with events as (
  select d.start_date as date, 'drive_start' as event, d.start_\${preferred_range}_range_km as range, d.start_km as odometer,
         d.distance is null as incomplete, ${driveStateSql("d")} = 'incomplete' as broken
  from drives d where d.car_id = $car_id and $__timeFilter(d.start_date)
  union all
  select coalesce(d.end_date, d.start_date + interval '1 second'), 'drive_end', d.end_\${preferred_range}_range_km, d.end_km,
         d.distance is null, ${driveStateSql("d")} = 'incomplete'
  from drives d where d.car_id = $car_id and $__timeFilter(d.start_date)
  union all
  select cp.start_date, 'charging_process_start', cp.start_\${preferred_range}_range_km, p.odometer, cp.end_date is null,
         ${chargeStateSql("cp")} = 'incomplete'
  from charging_processes cp join positions p on p.id = cp.position_id
  where cp.car_id = $car_id and $__timeFilter(cp.start_date)
  union all
  select coalesce(cp.end_date, cp.start_date + interval '1 second'), 'charging_process_end', cp.end_\${preferred_range}_range_km,
         p.odometer, cp.end_date is null, ${chargeStateSql("cp")} = 'incomplete'
  from charging_processes cp join positions p on p.id = cp.position_id
  where cp.car_id = $car_id and $__timeFilter(cp.start_date)
),
steps as (
  select
    date_trunc('$period', timezone('UTC', date), '$__timezone') as date,
    case when incomplete then 0 else lead(odometer) over w - odometer end as distance,
    case when incomplete then 0
         when event != 'drive_start' then greatest(range - lead(range) over w, 0)
         else range - lead(range) over w end as range_loss,
    broken
  from events
  window w as (order by date asc)
)
select s.date,
  sum(s.range_loss) * c.efficiency as range_energy,
  convert_km(sum(s.distance)::numeric, '$length_unit') as range_distance,
  (sum(s.range_loss) * c.efficiency * 1000) / nullif(convert_km(sum(s.distance)::numeric, '$length_unit'), 0) as cons_gross,
  bool_or(s.broken) as broken
from steps s
join cars c on c.id = $car_id
group by s.date, c.efficiency`;

// ---------------------------------------------------------------- 周期（本地时间，和 SQL 的 date_trunc 一致：周从周一开始）

// 天 / 周 / 月和图表的分桶是同一个东西；年用年月日算，跨夏令时也不会差一小时
function periodStart(ms, period) {
  return period === "year" ? new Date(new Date(ms).getFullYear(), 0, 1).getTime() : chart.bucketOf(ms, period);
}

function nextStart(ms, period) {
  return period === "year" ? new Date(new Date(ms).getFullYear() + 1, 0, 1).getTime() : chart.bucketEnd(ms, period);
}

// 列表里的周期名
function periodLabel(start, period) {
  if (period === "day") return fmt.day(start);
  if (period === "week") return fmt.dateRange(start, nextStart(start, "week") - 1);
  if (period === "month") return fmt.month(start);
  return fmt.year(start);
}

// 提示框标题：和别的分桶柱状图一样（「9月24日 周四」「9月21日 起的一周」「2026年9月」）
function tipTitle(start, period) {
  return period === "year" ? fmt.year(start) : chart.bucketTitle(start, period);
}

// 坐标轴上的短名字。按月：一月和第一根柱子下面带上年份；按天 / 周：跨年时第一根和每年的第一根带上年份
// （不然「12/29 … 1/19」看不出是哪年）
function axisLabel(start, prevStart, period, multiYear) {
  const d = new Date(start);
  if (period === "year") return String(d.getFullYear());
  const newYear = prevStart == null || new Date(prevStart).getFullYear() !== d.getFullYear();
  if (period === "month") return newYear ? `${d.getMonth() + 1}月\n${d.getFullYear()}` : `${d.getMonth() + 1}月`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return multiYear && newYear ? `${md}\n${d.getFullYear()}` : md;
}

// 点进行程 / 充电 / 旅程时带的范围（URL 参数 r）：整个周期，和面板的链接一样
function periodKey(start, period) {
  const ymd = (ms) => fmt.isoDate(ms).replace(/-/g, "");
  if (period === "month") return fmt.isoDate(start).slice(0, 7);
  if (period === "year") return String(new Date(start).getFullYear());
  return `${ymd(start)}-${ymd(nextStart(start, period) - 1)}`;
}

// ---------------------------------------------------------------- 数据

// 三条查询按周期拼成一行；派生列的算法和面板的 transformations 一样
function mergeRows(d, period) {
  const map = new Map();
  const get = (ms) => {
    const k = periodStart(ms, period);
    let p = map.get(k);
    if (!p) {
      p = { start: k, drives: 0, charges: 0 };
      map.set(k, p);
    }
    return p;
  };
  for (const r of d.drives) {
    Object.assign(get(r.date), {
      duration: r.duration,
      distance: r.distance,
      temp: r.temp,
      drives: r.drives,
      brokenDrives: r.broken_drives,
      efficiency: r.efficiency,
      energy: r.energy,
      logged: r.logged,
      consNet: r.cons_net
    });
  }
  for (const r of d.charges) {
    Object.assign(get(r.date), { used: r.used, added: r.added, cost: r.cost, charges: r.charges, brokenCharges: r.broken_charges });
  }
  for (const r of d.gross) {
    // 只有毛能耗的周期（比如前一天夜里开始、这天凌晨结束的充电）没有别的数，不单独占一行
    const k = periodStart(r.date, period);
    if (!map.has(k)) continue;
    Object.assign(map.get(k), { consGross: r.cons_gross, broken: r.broken });
  }
  for (const p of map.values()) {
    p.avgCharge = p.charges > 0 && p.used != null ? p.used / p.charges : null;
    // 面板：元/度 = 费用 ÷ 充电量（从电网取）；元/百公里 = 毛能耗 × 费用 ÷ 充入电量 ÷ 10
    p.costKwh = p.cost != null && p.used > 0 ? p.cost / p.used : null;
    p.cost100 = p.cost != null && p.consGross != null && p.added > 0 ? (p.consGross * (p.cost / p.added)) / 10 : null;
    p.overhead = p.consNet != null && p.consGross > 0 ? 1 - p.consNet / p.consGross : null;
  }
  return [...map.values()].sort((a, b) => b.start - a.start);
}

function totals(rows, gross, span) {
  const t = { distance: 0, drives: 0, energy: 0, logged: 0, used: 0, added: 0, cost: null, charges: 0, rangeEnergy: 0, rangeDistance: 0 };
  for (const p of rows) {
    t.distance += +p.distance || 0;
    t.drives += p.drives;
    t.energy += +p.energy || 0;
    t.logged += +p.logged || 0;
    t.used += +p.used || 0;
    t.added += +p.added || 0;
    t.charges += p.charges;
    if (p.cost != null) t.cost = (t.cost || 0) + +p.cost;
  }
  // 毛能耗按整段时间的总和算（不按周期平均）：用全部行，包括没单独占一行的
  for (const r of gross) {
    t.rangeEnergy += +r.range_energy || 0;
    t.rangeDistance += +r.range_distance || 0;
  }
  // 里程用整段的里程表读数差（见 SPAN_SQL）；取不到时才退回各周期之和
  if (span && span.distance != null) t.distance = +span.distance;
  // 库里是两位小数，累加完按分取整，免得 0.1 + 0.2 这种误差让最后一位跳
  t.used = Math.round(t.used * 100) / 100;
  t.added = Math.round(t.added * 100) / 100;
  if (t.cost != null) t.cost = Math.round(t.cost * 100) / 100;
  t.consNet = t.logged > 0 ? (t.energy * 1000) / t.logged : null;
  t.consGross = t.rangeDistance > 0 ? (t.rangeEnergy * 1000) / t.rangeDistance : null;
  t.costKwh = t.cost != null && t.used > 0 ? t.cost / t.used : null;
  t.cost100 = t.cost != null && t.consGross != null && t.added > 0 ? (t.consGross * (t.cost / t.added)) / 10 : null;
  return t;
}

// ---------------------------------------------------------------- 格式

// 面板的气温列：10 °C 以下偏冷、20 °C 以上偏热（°F 是 50 / 68）
function tempTone(v) {
  if (v == null) return "";
  const [cold, warm] = fmt.unit.temp === "°F" ? [50, 68] : [10, 20];
  return v < cold ? "cyan" : v < warm ? "green" : "amber";
}

// 面板的续航达成率：≥ 99% 绿，< 65% 橙
function effTone(v) {
  if (v == null) return "";
  return v >= 0.99 ? "green" : v < 0.65 ? "amber" : "";
}

function toned(text, tone) {
  return tone ? html`<span class="tm-tone-${tone}">${text}</span>` : text;
}

// 续航达成率是效率类的百分数，一位小数
const effText = (v) => fmt.pct(v * 100, 1);

// 次要的一行由几段拼成（「毛 198 · 额外 22%」），返回数组：卡片里用 ui.segs 折行，表格里用 dots 连成一行
function consSub(p) {
  if (p.consGross == null) return null;
  return [`毛 ${fmt.num(p.consGross)}`, p.overhead != null && `额外 ${fmt.share(p.overhead * 100)}`];
}

function costSub(p) {
  return [p.costKwh != null && `${fmt.money(p.costKwh)}/度`, p.cost100 != null && `${fmt.money(p.cost100)}/百${lenWord()}`];
}

const present = (x) => x != null && x !== false && x !== "";

function dots(list) {
  const items = [].concat(list).filter(present);
  return items.length ? html`${items.map((x, i) => html`${i ? " · " : ""}${x}`)}` : null;
}

// 周期被当前范围截掉一部分时（比如「近1年」的第一个月），写明实际统计的日子
function partialNote(p, period, r) {
  const end = nextStart(p.start, period);
  const cutStart = p.start < r.from;
  const cutEnd = end - 1 > r.to && r.to < Date.now() - 120e3;
  if (!cutStart && !cutEnd) return null;
  const a = Math.max(p.start, r.from);
  const b = Math.min(end - 1, r.to);
  return `只含 ${fmt.dateRange(a, b)}`;
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const period = api.oneOf(ctx.query.get("period"), PERIODS.map((p) => p.value), "month");
  const P = PERIODS.find((p) => p.value === period);
  ctx.setTitle(`${P.label}汇总`);
  ctx.setGrafanaVars({ "var-period": period });

  ui.render(ctx.root, html`${periodBar(period)}${ui.skeleton(["stats", "chart", "list"])}`);
  // 事件委托在 ctx.root 上，后面整页重画也不用再绑。换周期只改 period：范围的默认值跟着周期走（见 range.default），
  // 自己选过的范围照旧
  ui.onSegment(ctx.root, "period", (v) => ctx.setQuery({ period: v === "month" ? null : v }));

  const d = await api.batch(
    { drives: DRIVES_SQL, charges: CHARGES_SQL, gross: GROSS_SQL, span: SPAN_SQL, live: LIVE_SQL },
    { signal: ctx.signal, vars: { period } }
  );

  const rows = mergeRows(d, period);
  if (!rows.length) {
    ui.render(
      ctx.root,
      html`${periodBar(period)}${ui.card(
        ui.empty(`${ctx.range.label}没有记录到行程和充电。`, {
          icon: "calendar-month-outline",
          title: "没有行程和充电",
          // ctx.href 只保留 car / theme，周期要自己带上，不然按周看时点了会跳回按月
          action:
            ctx.range.key !== "all"
              ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/summary", { r: "all", period: period === "month" ? null : period }) })
              : null
        })
      )}`
    );
    return;
  }

  const t = totals(rows, d.gross, d.span[0]);
  // 正在充电 / 行驶的那一次落在哪个周期里，那一行标出来（它不计入这一行的数字）
  const live = d.live[0] || null;
  const env = { period, ctx, live };
  const hasLive = !!live && rows.some((p) => liveIn(p, env));
  const hasBroken = rows.some((p) => p.broken);

  ui.render(
    ctx.root,
    html`
      ${periodBar(period)}
      ${ui.stats(
        [
          // 合计驾驶时长不放这里（320 宽下一行放不下），每个周期的卡片 / 表格里有
          { label: "里程", icon: "road-variant", value: t.distance, digits: lenDigits(t.distance), unit: fmt.unit.len, sub: `${fmt.int(t.drives)} 次行程` },
          { label: "能耗（净）", icon: "leaf", value: t.consNet, unit: fmt.unit.cons, sub: t.consGross != null ? `毛 ${fmt.cons(t.consGross)}` : null },
          {
            label: "充电量",
            icon: "power-plug-outline",
            value: t.used,
            digits: t.used >= 10000 ? 0 : 1,
            unit: "kWh",
            sub: ui.segs([`${fmt.int(t.charges)} 次`, t.costKwh != null && `${fmt.money(t.costKwh)}/度`])
          },
          { label: "花费", icon: "cash-multiple", value: t.cost != null ? fmt.money(t.cost) : null, sub: t.cost100 != null ? `每百${lenWord()} ${fmt.money(t.cost100)}` : null }
        ],
        { cols: 4 }
      )}
      ${ui.card(
        html`<div class="pg-sum-chart-head">
            <h3 class="tm-card-title" id="pg-sum-chart-title">${chartTitle(P, metricPref)}</h3>
            ${ui.segmented("metric", METRICS, metricPref, { label: "图表指标" })}
          </div>
          ${ui.chartBox("pg-sum-chart", { height: 240, heightMobile: 200, label: "每个周期的柱状图" })}`
      )}
      ${ui.section(`每${P.unit}明细`, html`<div id="pg-sum-rows"></div>`, { sub: `共 ${fmt.int(rows.length)} ${P.noun}，新的在前` })}
      <p class="tm-note pg-sum-foot">${FOOT.join("")}${hasBroken ? FOOT_BROKEN : ""}${hasLive ? FOOT_LIVE : ""}</p>
    `
  );

  // ---- 明细：每次加 50 个周期（「再显示」只追加新的一段，按天看全部时有几百个周期）。
  // 桌面上画表格，手机和平板上一个周期一张卡片，同一时间只有一份 DOM；跨过断点（转屏、拖窗口）时按新的样子从第一页重画
  const box = ctx.root.querySelector("#pg-sum-rows");
  const mq = window.matchMedia(WIDE);
  const drawRows = () => {
    const asTable = mq.matches;
    ui.pager(box, {
      total: rows.length,
      page: PAGE,
      noun: P.noun,
      unit: P.noun,
      load: (offset) => {
        const part = rows.slice(offset, offset + PAGE);
        return asTable
          ? ui.card(table(part, env), { pad: false, attrs: { "data-tm-append": "table" } })
          : html`<div data-tm-append="cards"><div class="pg-sum-cards" data-tm-append-body>${cardItems(part, env)}</div></div>`;
      }
    });
  };
  drawRows();
  mq.addEventListener("change", drawRows);
  ctx.onCleanup(() => mq.removeEventListener("change", drawRows));

  // ---- 图表（ECharts 按需加载，明细先画出来）
  // option 传函数：每次绘制（包括换主题）都按当前指标生成；图表还在加载时切了指标，画出来的也是新的
  const slots = fillSlots(rows, period);
  const option = () => chartOption(slots, period, metricPref);
  let inst = null;
  ui.onSegment(ctx.root, "metric", (m) => {
    metricPref = api.oneOf(m, METRICS.map((x) => x.value), "distance");
    ctx.root.querySelector("#pg-sum-chart-title").textContent = chartTitle(P, metricPref);
    if (inst) chart.update(inst, option);
  });
  inst = await chart.create(ctx.root.querySelector("#pg-sum-chart"), option);
}

function chartTitle(P, metric) {
  return `每${P.unit}${METRICS.find((x) => x.value === metric).label}`;
}

function periodBar(period) {
  return html`<div class="pg-sum-bar">${ui.segmented("period", PERIODS, period, { label: "汇总周期" })}</div>`;
}

function liveIn(p, { period, live }) {
  return !!live && live.start_date >= p.start && live.start_date < nextStart(p.start, period);
}

// ---------------------------------------------------------------- 明细：手机卡片

function cell(label, value, sub, { href, tone } = {}) {
  const segs = [].concat(sub).filter(present);
  const body = html`<span class="pg-sum-cell-label">${label}${href ? ui.icon("chevron-right") : ""}</span>
    <span class="pg-sum-cell-value tm-num">${toned(value, tone)}</span>
    ${segs.length ? ui.segs(segs, { cls: "pg-sum-cell-sub" }) : ""}`;
  return href ? html`<a class="pg-sum-cell" href="${href}">${body}</a>` : html`<div class="pg-sum-cell">${body}</div>`;
}

// 周期里只有没计入次数的（中途断掉的、正在进行的）也链到列表：列表页最上面单独列着这几次，中途断掉的还写了怎么修
function links(p, env) {
  const { period, ctx } = env;
  const r = periodKey(p.start, period);
  const liveKind = liveIn(p, env) ? env.live.kind : null;
  return {
    trip: ctx.href("/stats/trip", { r }),
    drives: p.drives || p.brokenDrives || liveKind === "drive" ? ctx.href("/stats/drives", { r }) : null,
    charges: p.charges || p.brokenCharges || liveKind === "charge" ? ctx.href("/stats/charges", { r }) : null,
    charging: p.charges ? ctx.href("/stats/charging", { r }) : null
  };
}

function headBadges(p, env) {
  const { period, ctx, live } = env;
  const note = partialNote(p, period, ctx.range);
  return html`${
    liveIn(p, env) ? html`<span title="这一次还没结束，结束后才计入">${statePill(live.kind === "charge" ? "charging" : "driving")}</span>` : ""
  }${p.broken ? html`<span title="这段时间里有中途断掉的行程或充电，不计入次数，能耗可能有偏差">${ui.pill("数据不全", "amber", { icon: "alert-circle-outline" })}</span>` : ""}${
    note ? html`<span class="pg-sum-note">${note}</span>` : ""
  }`;
}

// 周期里没有计入次数的行程 / 充电时写明是哪种，别和标题上的「数据不全」「充电中」矛盾地写「没有充电」。
// 两种都有时写中途断掉的：正在进行的那一次标题上已经标了
function uncounted(broken, live, liveText, none) {
  if (broken) return [`${fmt.int(broken)} 次没有正常结束`, "不计入"];
  return live ? liveText : none;
}

function cardItems(rows, env) {
  const { period } = env;
  return html`${rows.map((p) => {
    const l = links(p, env);
    const liveKind = liveIn(p, env) ? env.live.kind : null;
    return html`<div class="tm-card pg-sum-card">
      <a class="pg-sum-head" href="${l.trip}" aria-label="${periodLabel(p.start, period)}：查看旅程">
        <span class="pg-sum-period">${periodLabel(p.start, period)}</span>
        ${headBadges(p, env)}
        ${ui.icon("chevron-right", { cls: "pg-sum-head-chevron" })}
      </a>
      <div class="pg-sum-grid">
        ${cell("里程", lenText(p.distance), p.drives ? [`${fmt.int(p.drives)} 次`, fmt.hours(p.duration)] : uncounted(p.brokenDrives, liveKind === "drive", "正在行驶，还没计入", "没有行程"), { href: l.drives })}
        ${cell("能耗", fmt.cons(p.consNet), consSub(p))}
        ${cell("耗电", fmt.kwh(p.energy), p.efficiency != null ? html`续航达成率 ${toned(effText(p.efficiency), effTone(p.efficiency))}` : null)}
        ${cell("平均气温", fmt.temp(p.temp), null, { tone: tempTone(p.temp) })}
        ${cell("充电", fmt.kwh(p.used), p.charges ? [`${fmt.int(p.charges)} 次`, `平均 ${fmt.kwh(p.avgCharge)}`] : uncounted(p.brokenCharges, liveKind === "charge", "正在充电，还没计入", "没有充电"), { href: l.charges })}
        ${cell("费用", fmt.money(p.cost), costSub(p), { href: l.charging })}
      </div>
    </div>`;
  })}`;
}

// ---------------------------------------------------------------- 明细：桌面表格

function two(main, sub) {
  const s = dots(sub);
  return html`<span class="pg-sum-td">${main}${s ? html`<small>${s}</small>` : ""}</span>`;
}

function table(rows, env) {
  const { period, ctx } = env;
  const L = new Map(rows.map((p) => [p.start, links(p, env)]));
  return ui.table({
    dense: true,
    rows,
    columns: [
      {
        key: "start",
        label: "周期",
        primary: true,
        fmt: (v, p) => html`<span class="pg-sum-td"><a class="pg-sum-period-link" href="${L.get(v).trip}" title="查看这段时间的旅程">${periodLabel(v, period)}</a>${
          p.broken || liveIn(p, env) || partialNote(p, period, ctx.range) ? html`<small class="pg-sum-badges">${headBadges(p, env)}</small>` : ""
        }</span>`
      },
      {
        key: "distance",
        label: "里程",
        align: "right",
        fmt: (v, p) => two(lenText(v), p.drives ? html`<a href="${L.get(p.start).drives}" title="查看这段时间的行程">${fmt.int(p.drives)} 次行程</a>` : null)
      },
      { key: "duration", label: "驾驶时长", align: "right", fmt: (v) => fmt.hours(v) },
      { key: "consNet", label: "能耗（净）", align: "right", fmt: (v, p) => two(fmt.cons(v), consSub(p)) },
      {
        key: "energy",
        label: "耗电",
        align: "right",
        fmt: (v, p) => two(fmt.kwh(v), p.efficiency != null ? html`达成率 ${toned(effText(p.efficiency), effTone(p.efficiency))}` : null)
      },
      { key: "temp", label: "气温", align: "right", fmt: (v) => toned(fmt.temp(v), tempTone(v)) },
      {
        key: "used",
        label: "充电量",
        align: "right",
        // 和面板一样：充电量链到充电统计，次数链到充电列表
        fmt: (v, p) =>
          p.charges
            ? two(
                html`<a href="${L.get(p.start).charging}" title="查看这段时间的充电统计">${fmt.kwh(v)}</a>`,
                html`<a href="${L.get(p.start).charges}" title="查看这段时间的充电">${fmt.int(p.charges)} 次</a> · 均 ${fmt.num(p.avgCharge, 1)}`
              )
            : fmt.kwh(v)
      },
      { key: "cost", label: "费用", align: "right", fmt: (v, p) => two(fmt.money(v), p.costKwh != null ? `${fmt.money(p.costKwh)}/度` : null) },
      { key: "cost100", label: `每百${lenWord()}`, align: "right", fmt: (v) => fmt.money(v) }
    ]
  });
}

// ---------------------------------------------------------------- 图表

// 从最早到最晚的每个周期都占一格（没数据的是空格），看得出哪几个月没开车
function fillSlots(rows, period) {
  const by = new Map(rows.map((p) => [p.start, p]));
  const first = rows[rows.length - 1].start;
  const last = rows[0].start;
  const out = [];
  for (let s = first; s <= last && out.length < 5000; s = nextStart(s, period)) out.push(by.get(s) || { start: s, drives: 0, charges: 0 });
  return out;
}

function chartOption(slots, period, metric) {
  const val = (k) => slots.map((p) => (p[k] == null ? null : +(+p[k]).toFixed(2)));
  let series;
  let unit;
  let extra = () => null;
  if (metric === "cons") {
    unit = fmt.unit.cons;
    series = [
      chart.bars("能耗（净）", val("consNet"), { color: "c1", fmt: (v) => fmt.cons(v) }),
      { ...chart.line("能耗（毛）", val("consGross"), { color: "c3", fmt: (v) => fmt.cons(v), symbol: true }), symbolSize: 6 }
    ];
    extra = (p) => (p.overhead != null ? { name: "额外", value: fmt.share(p.overhead * 100) } : null);
  } else if (metric === "used") {
    unit = "kWh";
    series = [chart.bars("充电量", val("used"), { color: "c4", fmt: (v) => fmt.kwh(v) })];
    extra = (p) => (p.charges ? { name: "充电", value: `${fmt.int(p.charges)} 次` } : null);
  } else if (metric === "cost") {
    unit = "元";
    series = [chart.bars("花费", val("cost"), { color: "c2", fmt: (v) => fmt.money(v) })];
    extra = (p) => (p.costKwh != null ? { name: "每度", value: fmt.money(p.costKwh) } : null);
  } else {
    unit = fmt.unit.len;
    series = [chart.bars("里程", val("distance"), { color: "c1", fmt: (v) => lenText(v) })];
    extra = (p) => (p.drives ? { name: "行程", value: `${fmt.int(p.drives)} 次` } : null);
  }
  const fmts = series.map((s) => s.tooltip.valueFormatter);
  const many = slots.length > ZOOM_BARS;
  const multiYear = new Date(slots[0].start).getFullYear() !== new Date(slots[slots.length - 1].start).getFullYear();
  return {
    xAxis: chart.categoryAxis(slots.map((p, i) => axisLabel(p.start, i ? slots[i - 1].start : null, period, multiYear))),
    yAxis: chart.valueAxis({ unit }),
    series,
    tooltip: chart.tooltip((ps) => {
      const list = Array.isArray(ps) ? ps : [ps];
      if (!list.length) return "";
      const p = slots[list[0].dataIndex];
      return chart.tipHtml(tipTitle(p.start, period), [
        ...list.map((x) => ({ color: x.color, name: x.seriesName, value: x.value == null ? "—" : fmts[x.seriesIndex](x.value) })),
        extra(p)
      ]);
    }),
    // 纵轴按缩放窗口里的柱子重算：按天看一年时，窗口外一天 800 多公里的长途会把默认显示的最近 60 天压成一排矮柱子。
    // 「能耗」带一条折线，核心默认按折线用 none，这里显式要 filter
    dataZoom: many ? chart.zoom({ start: 100 - (ZOOM_BARS / slots.length) * 100, end: 100, filterMode: "filter" }) : undefined
  };
}
