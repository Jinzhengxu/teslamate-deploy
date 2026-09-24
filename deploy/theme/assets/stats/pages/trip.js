// 旅程（对应 Grafana「Trip」面板 FkUpJpQZk）：把一段时间里的行程和充电连起来看，一般用来看一次长途。
// 地图 = 面板的 geomap（再加上充电点），统计宫格 = 面板右上那一串 stat 和「Total Energy added」横条，
// 时间分配 = 饼图「Time spent」+ 状态条（面板的 state-timeline），下面是电量 & 续航、海拔两张图和行程 / 充电列表。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import * as map from "../core/map.js";
import { DRIVE_ITEM_SQL, driveItem } from "./_drive-item.js";
import { CHARGE_ITEM_SQL, chargeItem } from "./_charge-item.js";
import { UNKNOWN_PLACE } from "./_shared.js";

export const title = "旅程";
// 面板的默认范围是「最近 3 次行程里最早那次的开始 → 现在」，要先查库才知道：交给外壳的 range.auto，
// 没有 r 时外壳先算完再画页头，换车时按新车重算。范围 key 只到天，所以是「那一天 0 点到现在」的「近 N 天」。
// 还没有行程（auto 返回 null）时按 default 画，空状态在 render 里处理
export const range = {
  default: "7d",
  auto: async (actx) => {
    const rows = await api.sql(LAST3_SQL, { signal: actx.signal });
    return rows[0] && rows[0].start != null ? daysKey(rows[0].start) : null;
  }
};
export const css = true;

const DRIVE_PAGE = 20;
const CHARGE_PAGE = 10;
const CHARGE_MAX = 300;

// ---------------------------------------------------------------- SQL（改编自面板，数字口径不变）

// 面板变量 from：最近 3 次行程里最早那次的开始。面板里没按车过滤（多车时会取到别的车），这里只看当前这辆
const LAST3_SQL = `select min(start_date) as start from (
  select start_date from drives where car_id = $car_id order by start_date desc limit 3
) x`;

const Q = {
  // 面板「Mileage」：范围内行程的位置点 + 不在行程里的位置点，里程表最大 − 最小
  mileage: `select convert_km((max(odometer) - min(odometer))::numeric, '$length_unit') as mileage
from positions
where car_id = $car_id and ideal_battery_range_km is not null
  and (drive_id in (select id from drives where $__timeFilter(start_date)) or drive_id is null and $__timeFilter(date))`,

  // 面板「Time spent」A：已结束的行程，起止位置点的时间差
  driving: `select sum(extract(epoch from end_position.date - start_position.date)) as sec
from drives
join positions start_position on start_position_id = start_position.id
join positions end_position on end_position_id = end_position.id
where drives.car_id = $car_id and $__timeFilter(start_date) and end_date is not null`,

  // 面板「Time spent」B：充电时长（截到范围内），按相数的众数分交流 / 直流
  charging: `with charges_current as (
  select cp.id,
         extract(epoch from least(end_date, $__timeTo()) - greatest(start_date, $__timeFrom())) as duration_sec,
         case when nullif(mode() within group (order by charger_phases), 0) is null then 'DC' else 'AC' end as current
  from charging_processes cp
  right join charges on cp.id = charges.charging_process_id
  where cp.car_id = $car_id and cp.charge_energy_added > 0
    and ($__timeFilter(start_date) or $__timeFilter(end_date))
  group by 1, 2
)
select current, coalesce(sum(duration_sec), 0) as sec from charges_current group by 1`,

  // 面板「Ø Speed excl. breaks」
  speed: `select convert_km(sum(end_position.odometer - start_position.odometer)::numeric, '$length_unit')
       / nullif(sum(extract(epoch from end_position.date - start_position.date)) / 3600, 0) as speed
from drives
join positions start_position on start_position_id = start_position.id
join positions end_position on end_position_id = end_position.id
where drives.car_id = $car_id and $__timeFilter(start_date) and end_date is not null`,

  // 面板「Ø Speed incl. DC charging」：行驶时间再加上直流充电的时间
  speedDc: `with dc_charges as (
  select cp.id,
         extract(epoch from cp.end_date - cp.start_date) as duration_sec,
         case when nullif(mode() within group (order by charger_phases), 0) is null then 'DC' else 'AC' end as current
  from charging_processes cp
  right join charges on cp.id = charges.charging_process_id
  where cp.car_id = $car_id and cp.charge_energy_added > 0
    and ($__timeFilter(start_date) or $__timeFilter(end_date))
  group by 1, 2
),
data as (
  (select sum(end_position.odometer - start_position.odometer) as distance,
          sum(extract(epoch from end_position.date - start_position.date)) as duration_sec
   from drives
   join positions start_position on start_position_id = start_position.id
   join positions end_position on end_position_id = end_position.id
   where drives.car_id = $car_id and $__timeFilter(start_date))
  union all
  (select null as distance, sum(duration_sec) from dc_charges where current = 'DC')
)
select convert_km(sum(distance)::numeric, '$length_unit') / nullif(sum(duration_sec) / 3600, 0) as speed from data`,

  // 面板「Ø Consumption (net)」
  consNet: `select sum((start_\${preferred_range}_range_km - end_\${preferred_range}_range_km) * car.efficiency * 1000)
       / nullif(convert_km(sum(distance)::numeric, '$length_unit'), 0) as consumption
from drives
join cars car on car.id = car_id
where $__timeFilter(start_date) and car_id = $car_id`,

  // 面板「Ø Consumption (gross)」：续航的全部损失（含停车、充电前后）× 能效。
  // 范围不到 48 小时按位置点逐点算，否则按行程 / 充电的起止事件算 —— 和面板（以及充电统计、能耗、按月汇总）同一段 SQL
  consGross: `with drives_start_event as (
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
  select car_id,
         case when is_incomplete then 0 else lead(odometer) over w - odometer end as distance,
         case when is_incomplete then 0 else case when event != 'drive_start' then greatest(range - lead(range) over w, 0) else range - lead(range) over w end end as range_loss
  from combined
  window w as (order by date asc)
)
select sum(range_loss) * c.efficiency as energy,
       (sum(range_loss) * c.efficiency * 1000) / nullif(convert_km(sum(distance)::numeric, '$length_unit'), 0) as consumption
from final
inner join cars c on car_id = c.id
group by c.efficiency`,

  // 面板「Total Charging Cost」：注意面板这里按结束时间过滤
  cost: `select sum(cost) as cost from charging_processes where $__timeFilter(end_date) and car_id = $car_id`,

  // 面板「Ø Cost per 100 km」的前一半：每度电单价 ÷ 里程 × 100；再乘上毛耗电（面板用 Join + 计算字段做的）
  costRate: `with charges as (
  select sum(cost) / nullif(sum(charge_energy_added), 0) as cost_per_kwh
  from charging_processes
  where car_id = $car_id and $__timeFilter(start_date)
),
mileage as (
  select convert_km((max(odometer) - min(odometer))::numeric, '$length_unit') as distance
  from positions
  where car_id = $car_id and ideal_battery_range_km is not null
    and (drive_id in (select id from drives where $__timeFilter(start_date)) or drive_id is null and $__timeFilter(date))
)
select cost_per_kwh / nullif(distance, 0) * 100 as cost_mileage from mileage cross join charges`,

  // 面板「Total Energy added」横条（交流 / 直流）
  added: `with charges_current as (
  select cp.id, cp.charge_energy_added as energy_added,
         case when nullif(mode() within group (order by charger_phases), 0) is null then 'DC' else 'AC' end as current
  from charging_processes cp
  right join charges on cp.id = charges.charging_process_id
  where cp.car_id = $car_id and cp.charge_energy_added > 0
    and ($__timeFilter(start_date) or $__timeFilter(end_date))
  group by 1, 2
)
select current, sum(energy_added) as energy from charges_current group by 1`,

  // 面板没有的补充：行程次数（含未结束的，和面板的行程表一致）、最高速度
  drives: `select count(*) as n, max(convert_km(speed_max::numeric, '$length_unit')) as speed_max,
       min(start_date) as first_start, max(coalesce(end_date, start_date)) as last_end
from drives where car_id = $car_id and $__timeFilter(start_date)`
};

// 面板的状态条：充电、行驶、更新的起止 + states 表，按时间排好，每个值一直持续到下一行
const STATES_SQL = `with states as (
  select unnest(array[start_date + interval '1 second', end_date]) as date, unnest(array[2, 0]) as state
  from charging_processes
  where car_id = $car_id and ($__timeFrom()::timestamp - interval '30 day') < start_date
    and (end_date < ($__timeTo()::timestamp + interval '30 day') or end_date is null)
  union
  select unnest(array[start_date + interval '1 second', end_date]) as date, unnest(array[1, 0]) as state
  from drives
  where car_id = $car_id and ($__timeFrom()::timestamp - interval '30 day') < start_date
    and (end_date < ($__timeTo()::timestamp + interval '30 day') or end_date is null)
  union
  select start_date as date,
         case when state = 'offline' then 3 when state = 'asleep' then 4 when state = 'online' then 5 end as state
  from states
  where car_id = $car_id and ($__timeFrom()::timestamp - interval '30 day') < start_date
    and (end_date < ($__timeTo()::timestamp + interval '30 day') or end_date is null)
  union
  select unnest(array[start_date + interval '1 second', end_date]) as date, unnest(array[6, 0]) as state
  from updates
  where car_id = $car_id and ($__timeFrom()::timestamp - interval '30 day') < start_date
    and (end_date < ($__timeTo()::timestamp + interval '30 day') or end_date is null)
)
select date as time, state from states
where date is not null
  and ($__timeFrom()::timestamp - interval '30 day') < date
  and date < ($__timeTo()::timestamp + interval '30 day')
order by date asc, state asc`;

// 地图轨迹：面板的写法（范围内开始的行程的全部点 + 不在行程里的点），面板固定 5 秒一组；
// 范围长了按比例放宽（90 天按 5 秒是一万多个点，手机上既慢又没必要）。
// 和上一个点几乎同一位置（约 10 米内）的不要：停车时的点全是原地，全部范围里约占三成
const TRACK_SQL = `with unioned_positions as (
  select p.date, p.latitude, p.longitude
  from positions p
  inner join drives d on p.drive_id = d.id
  where p.car_id = $car_id and $__timeFilter(d.start_date)
  union all
  select p.date, p.latitude, p.longitude
  from positions p
  where p.car_id = $car_id and p.drive_id is null and $__timeFilter(p.date)
),
m as (
  select to_timestamp(floor(extract(epoch from date) / $bucket) * $bucket) as time,
         avg(latitude) as latitude,
         avg(longitude) as longitude
  from unioned_positions
  group by 1
),
l as (
  select time, latitude, longitude, lag(latitude) over w as plat, lag(longitude) over w as plng
  from m
  window w as (order by time)
)
select time, round(latitude::numeric, 5) as lat, round(longitude::numeric, 5) as lng
from l
where plat is null or abs(latitude - plat) > 0.0001 or abs(longitude - plng) > 0.0001
order by time`;

// 电量 & 续航：位置点和充电记录合在一起（充电时电量是往上走的那段）。面板取范围前后各多一天，这里只取范围内
const LEVEL_SQL = `(
  select to_timestamp(floor(extract(epoch from date) / $cbucket) * $cbucket) as time,
         avg(battery_level) as soc,
         convert_km(avg(\${preferred_range}_battery_range_km)::numeric, '$length_unit') as range
  from positions
  where car_id = $car_id and $__timeFilter(date)
  group by 1
) union all (
  select to_timestamp(floor(extract(epoch from date) / $cbucket) * $cbucket) as time,
         avg(battery_level) as soc,
         convert_km(avg(\${preferred_range}_battery_range_km)::numeric, '$length_unit') as range
  from charges c
  left join charging_processes p on c.charging_process_id = p.id
  where p.car_id = $car_id and $__timeFilter(date)
  group by 1
)
order by 1`;

// 海拔：streaming 推送点才有海拔（完整记录的海拔是空的），空值不取
const ELEV_SQL = `select to_timestamp(floor(extract(epoch from date) / $cbucket) * $cbucket) as time,
       round(convert_m(avg(elevation), '$alternative_length_unit')) as elevation
from positions
where car_id = $car_id and $__timeFilter(date) and elevation is not null
group by 1
order by 1`;

// ---------------------------------------------------------------- 小工具

// 状态码（面板的值映射）→ 名字和颜色。0 和 5 都是「在线」（行程 / 充电结束后回到在线）
const STATE = {
  0: { name: "在线", color: "c5" },
  1: { name: "行驶", color: "c1" },
  2: { name: "充电", color: "c4" },
  3: { name: "离线", color: "c6" },
  4: { name: "休眠", color: "c3" },
  5: { name: "在线", color: "c5" },
  6: { name: "更新", color: "amber" }
};

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// 从某一刻到今天，对应的「近 N 天」key（含今天）
function daysKey(ms) {
  const today = new Date();
  const a = new Date(dayStart(ms));
  const n = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - a) / 86400e3) + 1;
  return `${Math.max(1, Math.min(3650, n))}d`;
}

// 「10月2日–5日」「9月30日–10月3日」：统计格子里窄，不带年份和空格。
// 跨年又很长（「全部」「近1年」）时不带年份会看成一个月，写成「2025年8月25日起」
function shortSpan(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  if (da.getFullYear() !== db.getFullYear() && b - a > 180 * 86400e3) return `${fmt.dateY(a)}起`;
  if (da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth()) return `${fmt.date(a)}–${db.getDate()}日`;
  return `${fmt.date(a)}–${fmt.date(b)}`;
}

// 占比：不是 0 的项别显示成「0%」，没占满的别显示成「100%」
function share(p) {
  if (p > 0 && p < 1) return "<1%";
  if (p > 99 && p < 100) return ">99%";
  return fmt.pct(p);
}

// 面板里的时长是秒。超过一天显示「1天3小时」，统计格子里放得下
function hours(sec) {
  return sec > 0 ? fmt.duration(sec / 60) : null;
}

// 时间轴。核心的刻度在月初那一刻只写「5月」，一两天的范围里像是写错了，短范围改成「5月1日」
function timeAxis(from, end, extra = {}) {
  const short = end - from <= 62 * 86400e3;
  return chart.timeAxis({ min: from, max: end, ...(short ? { axisLabel: { formatter: { month: "{M}月{d}日" } } } : {}), ...extra });
}

// 状态行 → 连续的段（截到 [from, end]），相邻同名的合并（面板的 mergeValues）
function stateSegments(rows, from, end) {
  const segs = [];
  for (let i = 0; i < rows.length; i++) {
    const st = STATE[rows[i].state];
    if (!st) continue;
    const a = Math.max(rows[i].time, from);
    const b = Math.min(i + 1 < rows.length ? rows[i + 1].time : end, end);
    if (!(b > a)) continue;
    const last = segs[segs.length - 1];
    if (last && last.name === st.name && last.end >= a) last.end = b;
    else segs.push({ lane: 0, start: a, end: b, color: st.color, name: st.name });
  }
  return segs;
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  // 没指定范围：按面板的逻辑找最近 3 次行程，从最早那次的当天到今天（范围按天，URL 里就是「近 N 天」）
  if (!ctx.query.get("r")) {
    ui.render(ctx.root, ui.skeleton(["map", "stats"]));
    const rows = await api.sql(LAST3_SQL, { signal: ctx.signal });
    const start = rows[0] && rows[0].start;
    if (start == null) {
      ui.render(ctx.root, ui.card(ui.empty("TeslaMate 记录到行程后，这里会显示最近一次出行。", { icon: "map-marker-distance", title: "还没有行程" })));
      return;
    }
    ctx.setQuery({ r: daysKey(start) });
    return;
  }

  ui.render(ctx.root, ui.skeleton(["map", "stats", "chart", "list"], { height: 320 }));

  const r = ctx.range;
  const end = Math.min(r.to, Date.now());
  // 长范围先确认车从什么时候开始有记录（每辆车只查一次），图表、时间分配从那天算
  let from = r.from;
  if (end - from > 60 * 86400e3) {
    let t0 = firstSeen.get(ctx.car.id);
    if (t0 === undefined) {
      const rows = await api.sql(FIRST_SQL, { signal: ctx.signal });
      t0 = rows[0] ? rows[0].t : null;
      firstSeen.set(ctx.car.id, t0);
    }
    if (t0 != null && t0 > from) from = dayStart(t0);
  }
  const spanSec = Math.max(60, (end - from) / 1000);
  // 地图按范围长短定分组（面板 5 秒）；图表点数控制在一两千个（屏幕也就这么宽）
  const bucket = spanSec <= 3 * 86400 ? 5 : spanSec <= 14 * 86400 ? 15 : spanSec <= 60 * 86400 ? 30 : 60;
  const cbucket = Math.max(5, Math.round(spanSec / 1500));

  // 明细（轨迹、曲线、状态条）和汇总同时发，汇总回来就先画
  const loadDetails = () =>
    api.batch(
      {
        track: { sql: TRACK_SQL, vars: { bucket }, maxDataPoints: 100000 },
        level: { sql: LEVEL_SQL, vars: { cbucket }, maxDataPoints: 100000 },
        elev: { sql: ELEV_SQL, vars: { cbucket }, maxDataPoints: 100000 },
        states: { sql: STATES_SQL, maxDataPoints: 100000 }
      },
      { signal: ctx.signal }
    );
  const detailP = loadDetails();
  detailP.catch(() => {});

  const d = await api.batch(
    {
      ...Q,
      driveList: DRIVE_ITEM_SQL("$__timeFilter(d.start_date)", { incomplete: true, limit: DRIVE_PAGE }),
      // 面板的充电表只按开始时间取；这里把「结束在范围内」的也列上（比如出发前一晚插上、早上才充完的那次）：
      // 上面的充电时长、充入电量、花费都算了它，列表里没有就对不上
      chargeList: CHARGE_ITEM_SQL("$__timeFilter(cp.start_date) or $__timeFilter(cp.end_date)", { incomplete: true, limit: CHARGE_MAX })
    },
    { signal: ctx.signal }
  );

  const one = (k) => d[k][0] || {};
  const nDrives = one("drives").n || 0;
  const charges = d.chargeList;

  if (!nDrives && !charges.length) {
    ui.render(
      ctx.root,
      ui.card(
        ui.empty(`${r.label}没有行程，也没有充电。`, {
          icon: "map-marker-distance",
          title: "这段时间没有出行",
          action: ui.button("看最近一次出行", { kind: "soft", href: ctx.href("/stats/trip", { r: null }) })
        })
      )
    );
    return;
  }

  // ---- 汇总数字（每一项都对应面板的一格）
  const by = (rows, key) => Object.fromEntries(rows.map((x) => [x.current, +x[key] || 0]));
  const chg = by(d.charging, "sec");
  const add = by(d.added, "energy");
  const driveSec = +one("driving").sec || 0;
  const chargeSec = (chg.AC || 0) + (chg.DC || 0);
  const gross = one("consGross");
  const cost = one("cost").cost;
  const rate = one("costRate").cost_mileage;
  const per100 = rate != null && gross.energy != null ? rate * gross.energy : null;
  const mileage = one("mileage").mileage;
  // 库里是两位小数，按分取整再加，免得 33.12 + 37.83 = 70.9499… 显示成 70.9（足迹页同一段时间是 71.0）
  const addedTotal = Math.round(((add.AC || 0) + (add.DC || 0)) * 100) / 100;
  // 面板没有「总时长」：这里取第一次出发到最后一次到达，长途时就是「路上一共花了多久」
  const dr = one("drives");
  const tripSec = dr.first_start != null && dr.last_end > dr.first_start ? (dr.last_end - dr.first_start) / 1000 : null;
  const tripSpan =
    tripSec == null
      ? null
      : dayStart(dr.first_start) === dayStart(dr.last_end)
        ? `${fmt.time(dr.first_start)} – ${fmt.time(dr.last_end)}`
        : shortSpan(dr.first_start, dr.last_end);
  const avgSpeed = one("speed").speed;
  // 充入电量的副标题：交流 / 直流各多少（面板的横条）。整数就够看出比例（窄屏上放不下两个一位小数）；
  // 数大了（「直流 519 · 交流 1,954」）320 宽放不下，改写直流占比。只有一种时不写数（「377.5 kWh / 交流 378」像是对不上）
  let addedSub = null;
  if (addedTotal > 0) {
    const both = `直流 ${fmt.num(add.DC, 0)} · 交流 ${fmt.num(add.AC, 0)}`;
    addedSub = add.DC && add.AC ? (both.length <= 14 ? both : `直流占 ${share((add.DC / addedTotal) * 100)}`) : add.DC ? "全部是直流" : "全部是交流";
  }

  const statsHtml = ui.stats(
    [
      { label: "里程", icon: "road-variant", value: fmt.num(mileage, mileage != null && mileage < 100 ? 1 : 0), unit: fmt.unit.len, sub: `${fmt.int(nDrives)} 次行程` },
      { label: "总时长", icon: "clock-outline", value: hours(tripSec), sub: tripSpan },
      { label: "行驶时长", icon: "car-clock", value: hours(driveSec), sub: avgSpeed != null ? `均速 ${fmt.speed(avgSpeed)}` : null },
      { label: "充电时长", icon: "ev-station", value: hours(chargeSec), sub: charges.length ? `${fmt.int(charges.length)} 次充电` : "没有充电" },
      { label: "最高速度", icon: "speedometer", value: fmt.num(dr.speed_max, 0), unit: fmt.unit.speed },
      // 面板「Ø Speed incl. DC charging」：路上停下来快充的时间也算进去，更接近「到目的地要多久」
      { label: "全程均速", icon: "timer-outline", value: fmt.num(one("speedDc").speed, 0), unit: fmt.unit.speed, sub: "含直流充电时间" },
      { label: "能耗（净）", icon: "leaf", value: fmt.num(one("consNet").consumption, 0), unit: fmt.unit.cons, sub: gross.consumption != null ? `毛 ${fmt.cons(gross.consumption)}` : null },
      { label: "耗电（毛）", icon: "battery-50", value: fmt.num(gross.energy, 1), unit: "kWh", sub: "含停车、空调等" },
      {
        label: "充入电量",
        icon: "battery-charging-high",
        value: addedTotal > 0 ? fmt.num(addedTotal, 1) : null,
        unit: "kWh",
        sub: addedSub
      },
      { label: "充电花费", icon: "cash-multiple", value: cost != null ? fmt.money(cost) : null, sub: per100 != null ? `每百${fmt.unit.len === "km" ? "公里" : "英里"} ${fmt.money(per100)}` : null }
    ],
    { cols: 2 }
  );

  // ---- 时间分配：面板的饼图只有行驶 / 交流充电 / 直流充电三块，这里再补上剩下的时间（停车、休眠等），比例按整个范围算
  const otherSec = Math.max(0, spanSec - driveSec - chargeSec);
  const alloc = [
    { label: "行驶", sec: driveSec, color: "var(--tm-c1)" },
    { label: "交流充电", sec: chg.AC || 0, color: "var(--tm-c4)" },
    { label: "直流充电", sec: chg.DC || 0, color: "var(--tm-c2)" },
    { label: "停车等", sec: otherSec, color: "var(--tm-track)" }
  ].filter((x) => x.sec > 0);
  const allocSum = alloc.reduce((s, x) => s + x.sec, 0) || 1;

  ui.render(
    ctx.root,
    html`
      <div class="pg-trip-top">
        ${ui.card(
          html`${ui.mapBox("pg-trip-map", { height: 440 })}
            <div class="pg-trip-foot tm-note" id="pg-trip-foot">正在读取轨迹…</div>`,
          { pad: false, cls: "pg-trip-mapcard" }
        )}
        ${statsHtml}
      </div>

      ${ui.section(
        "时间分配",
        ui.card(html`
          <div class="pg-trip-alloc" role="img" aria-label="${alloc.map((x) => `${x.label} ${hours(x.sec)}`).join("，")}">
            ${alloc.map((x) => html`<span style="width:${((x.sec / allocSum) * 100).toFixed(2)}%;background:${x.color}"></span>`)}
          </div>
          <div class="pg-trip-alloc-legend">
            ${alloc.map(
              (x) => html`<div><i style="background:${x.color}"></i><span>${x.label}</span><b class="tm-num">${hours(x.sec)}</b><em class="tm-num">${share((x.sec / allocSum) * 100)}</em></div>`
            )}
          </div>
          <div class="pg-trip-states">
            ${ui.chartBox("pg-trip-states", { height: 76, heightMobile: 76, label: "车辆状态时间线" })}
            <div id="pg-trip-states-legend"></div>
          </div>`),
        { sub: `${fmt.dateTime(from)} – ${dayStart(end) === dayStart(from) ? fmt.time(end) : fmt.dateTime(end)}，共 ${hours(spanSec)}${from > r.from ? "（从最早的记录算起）" : ""}` }
      )}

      <div class="tm-grid-2">
        ${ui.section("电量和续航", ui.card(ui.chartBox("pg-trip-level", { height: 240, heightMobile: 210, label: "电量和续航曲线" })))}
        ${ui.section("海拔", ui.card(ui.chartBox("pg-trip-elev", { height: 240, heightMobile: 210, label: "海拔曲线" })))}
      </div>

      <div class="tm-grid-2 pg-trip-lists">
        ${ui.section(
          "行程",
          nDrives
            ? html`${ui.card(html`<div id="pg-trip-drives"></div>`, { pad: false })}<div id="pg-trip-drives-more"></div>`
            : ui.card(ui.empty("这段时间没有行程。", { icon: "road-variant" })),
          { sub: nDrives ? `${fmt.int(nDrives)} 次` : null }
        )}
        ${ui.section(
          "充电",
          charges.length
            ? html`${ui.card(html`<div id="pg-trip-charges"></div>`, { pad: false })}<div id="pg-trip-charges-more"></div>`
            : ui.card(ui.empty("这段时间没有充电。", { icon: "ev-station" })),
          { sub: charges.length ? `${fmt.int(charges.length)} 次${charges.length >= CHARGE_MAX ? "（只列出最近的）" : ""}` : null }
        )}
      </div>
    `
  );

  drawDrives(ctx, d.driveList, nDrives);
  drawCharges(ctx, charges);

  // ---- 明细（detailP 已经在路上了，和地图同时准备）
  const m = await map.create(ctx.root.querySelector("#pg-trip-map"));
  if (!m) return;
  await drawDetails(ctx, { m, detailP, loadDetails, charges, from, end });
}

// 明细出错时只在地图下面报错（带重试），图表位置写一句没取到；上面的统计和下面的列表留着，不让整页变成错误卡片
async function drawDetails(ctx, { m, detailP, loadDetails, charges, from, end }) {
  const foot = ctx.root.querySelector("#pg-trip-foot");
  const boxes = ["#pg-trip-level", "#pg-trip-elev", "#pg-trip-states"].map((q) => ctx.root.querySelector(q));
  let t;
  try {
    t = await detailP;
  } catch (e) {
    if (e.name === "AbortError") return;
    for (const box of boxes) {
      ui.render(box, html`<p class="tm-note">没取到数据</p>`);
      box.classList.add("pg-trip-nochart");
    }
    ui.render(
      foot,
      ui.error(e, () => {
        ui.render(foot, "正在读取轨迹…");
        for (const box of boxes) {
          ui.render(box, "");
          box.classList.remove("pg-trip-nochart");
        }
        drawDetails(ctx, { m, detailP: loadDetails(), loadDetails, charges, from, end }).catch(() => {});
      })
    );
    return;
  }
  drawMap(ctx, m, t.track, charges);
  await Promise.all([drawStates(ctx, t.states, from, end), drawLevel(ctx, t.level, from, end), drawElev(ctx, t.elev, from, end)]);
}

// ---------------------------------------------------------------- 地图

function drawMap(ctx, m, track, charges) {
  const foot = ctx.root.querySelector("#pg-trip-foot");
  const segs = splitTrack(track);
  const layers = segs.map((s) => map.track(m, s, { color: "accent", weight: 4 }));
  const pts = segs.flat();
  if (pts.length) {
    map.marker(m, pts[0], { kind: "start", title: "开始" });
    map.marker(m, pts[pts.length - 1], { kind: "end", title: "结束" });
  }
  // 充电点：同一个地方（比如家）充很多次时只标一个，弹出框里写次数。
  // 同一个收藏点、或者相距约 200 米以内算同一处（每次停的车位差几十米；按坐标取整分组会在格子边界上拆成两个）
  const spots = [];
  for (const c of charges) {
    if (c.latitude == null || c.longitude == null) continue;
    const lat = +c.latitude;
    const lng = +c.longitude;
    let s = spots.find((x) => (c.geofence_id != null && x.gid === c.geofence_id) || (Math.abs(x.lat - lat) < 0.002 && Math.abs(x.lng - lng) < 0.0025));
    if (!s) {
      s = { lat, lng, gid: c.geofence_id, place: c.place || UNKNOWN_PLACE, rows: [] };
      spots.push(s);
    }
    s.rows.push(c);
  }
  const marks = [];
  for (const s of spots) {
    const last = s.rows[0];
    const popup =
      s.rows.length > 1
        ? html`<strong>${s.place}</strong><br>充了 ${s.rows.length} 次，共 ${fmt.kwh(s.rows.reduce((a, x) => a + (+x.energy_added || 0), 0))}`
        : html`<strong>${s.place}</strong><br>${fmt.dateTime(last.start_date)} · ${fmt.kwh(last.energy_added)}${last.cost != null ? html` · ${fmt.money(last.cost)}` : ""}`;
    // 压在起终点下面：从家出发前充过电时两个标记叠在一起，「起」更要紧
    const mk = map.marker(m, [s.lat, s.lng], { kind: "charge", title: s.place, popup, zIndexOffset: 0 });
    if (mk) marks.push(mk);
  }
  if (layers.length || marks.length) map.fit(m, [...layers, ...marks], { padding: 32 });
  ui.render(
    foot,
    pts.length
      ? `${fmt.int(track.length)} 个位置点${spots.length ? ` · ${spots.length} 个充电地点` : ""}`
      : "这段时间没有位置记录，地图上只标了充电地点。"
  );
}

// ---------------------------------------------------------------- 图表

async function drawStates(ctx, rows, from, end) {
  const segs = stateSegments(rows, from, end);
  const box = ctx.root.querySelector("#pg-trip-states");
  if (!segs.length) {
    box.closest(".pg-trip-states").hidden = true;
    return;
  }
  const names = [...new Set(segs.map((s) => s.name))];
  const colorOf = Object.fromEntries(segs.map((s) => [s.name, s.color]));
  ui.render(ctx.root.querySelector("#pg-trip-states-legend"), ui.legend(names.map((n) => ({ label: n, color: `var(--tm-${colorOf[n]})` }))));
  await chart.create(box, {
    // 左右没有纵轴文字，靠边的日期刻度会被切掉半个字（「月29日」），两边留点地方
    grid: { top: 4, bottom: 2, left: 24, right: 24 },
    xAxis: timeAxis(from, end, { splitLine: { show: true, lineStyle: { color: "@line" } } }),
    yAxis: chart.categoryAxis(["状态"], { axisLine: { show: false }, axisLabel: { show: false } }),
    series: [chart.timelineSeries(segs, { height: 0.7 })]
  });
}

async function drawLevel(ctx, rows, from, end) {
  const box = ctx.root.querySelector("#pg-trip-level");
  const pts = rows.filter((x) => x.soc != null || x.range != null).sort((a, b) => a.time - b.time);
  if (!pts.length) {
    ui.render(box, ui.empty("没有电量记录。", { icon: "battery-50" }));
    box.classList.add("pg-trip-nochart");
    return;
  }
  const rangeName = ctx.settings.preferredRange === "ideal" ? "理想续航" : "表显续航";
  await chart.create(box, {
    xAxis: timeAxis(from, end),
    yAxis: [
      chart.valueAxis({ unit: "%", min: 0, max: 100 }),
      chart.valueAxis({ unit: fmt.unit.len, position: "right", min: 0, splitLine: { show: false } })
    ],
    series: [
      { ...chart.line("电量", pts.filter((x) => x.soc != null).map((x) => [x.time, +(+x.soc).toFixed(1)]), { color: "c4", area: true, fmt: (v) => fmt.pct(v) }), connectNulls: true },
      { ...chart.line(rangeName, pts.filter((x) => x.range != null).map((x) => [x.time, +(+x.range).toFixed(1)]), { color: "c1", yAxisIndex: 1, width: 1.5, fmt: (v) => fmt.len(v) }), connectNulls: true }
    ],
    dataZoom: chart.zoom()
  });
}

async function drawElev(ctx, rows, from, end) {
  const box = ctx.root.querySelector("#pg-trip-elev");
  if (!rows.length) {
    ui.render(box, ui.empty("没有海拔记录（只有实时推送的位置点带海拔）。", { icon: "chart-areaspline" }));
    box.classList.add("pg-trip-nochart");
    return;
  }
  await chart.create(box, {
    // 右边没有纵轴文字，最右边的日期刻度会被切掉（「9月22E」），留点地方
    grid: { right: 24 },
    xAxis: timeAxis(from, end),
    yAxis: chart.valueAxis({ unit: fmt.unit.altLen, scale: true }),
    series: [chart.line("海拔", rows.map((x) => [x.time, x.elevation]), { color: "c5", area: true, fmt: (v) => fmt.alt(v) })],
    dataZoom: chart.zoom()
  });
}

// ---------------------------------------------------------------- 列表

// 行程：先 20 条，往下翻页（范围是「全部」时可能上千条）
function drawDrives(ctx, first, total) {
  const listEl = ctx.root.querySelector("#pg-trip-drives");
  const moreEl = ctx.root.querySelector("#pg-trip-drives-more");
  if (!listEl) return;
  const rows = first.slice();
  let loading = false;
  let failed = null;

  const draw = () => {
    ui.render(listEl, ui.list(rows.map((row) => driveItem(row, ctx))));
    const left = total - rows.length;
    ui.render(
      moreEl,
      failed
        ? html`<div class="pg-trip-more">${ui.error(failed, loadMore)}</div>`
        : left > 0
          ? html`<div class="pg-trip-more">${ui.button(loading ? "正在加载…" : `再显示 ${Math.min(DRIVE_PAGE, left)} 次`, {
              kind: "soft",
              attrs: { "data-more-drives": "", disabled: loading }
            })}<span class="tm-note">还有 ${fmt.int(left)} 次</span></div>`
          : ""
    );
  };

  async function loadMore() {
    if (loading) return;
    loading = true;
    failed = null;
    draw();
    try {
      const d = await api.batch(
        { more: DRIVE_ITEM_SQL("$__timeFilter(d.start_date)", { incomplete: true, limit: DRIVE_PAGE, offset: rows.length }) },
        { signal: ctx.signal }
      );
      const seen = new Set(rows.map((x) => x.id));
      rows.push(...d.more.filter((x) => !seen.has(x.id)));
      // 翻到底了（期间有行程被删之类）就别再显示「还有」
      if (d.more.length < DRIVE_PAGE) total = rows.length;
    } catch (e) {
      if (e.name === "AbortError") return;
      failed = e;
    } finally {
      loading = false;
    }
    draw();
  }

  moreEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-more-drives]")) loadMore();
  });
  draw();
}

// 充电：一般只有几次，全部一次取回（地图上的充电点也要用），列表先显示 10 条
function drawCharges(ctx, rows) {
  const listEl = ctx.root.querySelector("#pg-trip-charges");
  const moreEl = ctx.root.querySelector("#pg-trip-charges-more");
  if (!listEl) return;
  let shown = Math.min(rows.length, CHARGE_FIRST);
  const draw = () => {
    ui.render(listEl, ui.list(rows.slice(0, shown).map((row) => chargeItem(row, ctx))));
    ui.render(
      moreEl,
      shown < rows.length
        ? html`<div class="pg-trip-more">${ui.button(`显示全部 ${rows.length} 次`, { kind: "soft", attrs: { "data-more-charges": "" } })}</div>`
        : ""
    );
  };
  moreEl.addEventListener("click", (e) => {
    if (!e.target.closest("[data-more-charges]")) return;
    shown = rows.length;
    draw();
  });
  draw();
}
