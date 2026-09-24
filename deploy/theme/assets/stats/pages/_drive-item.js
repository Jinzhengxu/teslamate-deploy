/*
 * 行程列表行：行程页、统计首页、时间线、旅程共用，保证各处的行程长得一样、点进去都是 /stats/drives/:id。
 *
 *   DRIVE_ITEM_SQL(where, { limit, offset, incomplete })  一段完整 SQL（带 $car_id 等变量，直接交给 api.batch），按 start_date 倒序
 *   driveItem(row, ctx, { date })                  一行 → ui.list 的一项
 *   groupByDay(rows)                               按本地日期分组（行程列表的「今天 / 昨天 / 9月22日 周一」）
 *   driveTitle(row)                                「家 → 公司」
 *   lenText(v)                                     里程：≥100 取整、<100 一位小数（「8.2 km」「318 km」）
 *   timeSpan(start, end)                           「07:37–07:54」，跨午夜「23:06–次日 02:52」
 *   endTime(start, end)                            只要结束那一半：「07:54」/「次日 02:52」/ 再往后写日期
 *
 * where 是额外的 WHERE 条件片段，可以用这些表别名：
 *   d 行程（drives）、sa / ea 起终点地址、sg / eg 起终点地理围栏、sp / ep 起终点位置点（positions）
 * 例："$__timeFilter(d.start_date)"、"d.id = any(array[1,2,3])"。车辆条件（d.car_id = $car_id）已经带上了。
 * 默认不含没有结束的行程（incomplete: true 时带上）—— Grafana「Drives」面板的表格也不列它们。
 * limit / offset：分页（先取 limit 条，「加载更多」时 offset 往后翻）。
 *
 * 查出来的列（单位已按设置换算，页面只加单位）：
 *   id, start_date, end_date（毫秒）, duration_min, distance（km/mi）,
 *   start_place, end_place（围栏名优先的短地名，可能为 null）,
 *   start_soc, end_soc（%）, energy（净耗电 kWh）, consumption（净能耗 Wh/km 或 Wh/mi）,
 *   speed_max, speed_avg（km/h 或 mph）, power_max（kW）, outside_temp（°C/°F，平均）,
 *   ascent, descent（m 或 ft）, reduced_range（冷车续航打折，布尔）,
 *   efficiency（续航达成率，按爬升 / 下降修正，1 = 100%）, start_geofence_id, end_geofence_id,
 *   incomplete（没有结束的行程：TeslaMate 在行程中途停过）
 * 耗电、能耗、续航达成率的算法和 Grafana「Drives」面板的表格一样（续航差 × 车辆能效）。
 */
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as fmt from "../core/format.js";
import { placeSql, UNKNOWN_PLACE } from "./_shared.js";

export function DRIVE_ITEM_SQL(where, { limit, offset, incomplete = false } = {}) {
  const cond = where && String(where).trim() ? `(${where})` : "true";
  const lim = [
    Number.isSafeInteger(limit) && limit > 0 ? `limit ${limit}` : "",
    Number.isSafeInteger(offset) && offset > 0 ? `offset ${offset}` : ""
  ].join(" ");
  // 冷车续航打折（面板的 ❄ 列）：行程里超过 1/4 的位置点可用电量比显示电量低。
  // 只看有续航读数的点（streaming 推送点没有），和面板一样；用 (car_id, date) 的索引按时间段取，再按行程过滤
  return `with d0 as (
  select
    d.id, d.start_date, d.end_date, d.duration_min, d.distance,
    d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km as range_diff,
    d.speed_max, d.power_max, d.outside_temp_avg, d.ascent, d.descent,
    d.start_geofence_id, d.end_geofence_id,
    sp.battery_level as start_soc, ep.battery_level as end_soc,
    c.efficiency as car_efficiency,
    ${placeSql("sg", "sa")} as start_place,
    ${placeSql("eg", "ea")} as end_place
  from drives d
  join cars c on c.id = d.car_id
  left join addresses sa on sa.id = d.start_address_id
  left join addresses ea on ea.id = d.end_address_id
  left join geofences sg on sg.id = d.start_geofence_id
  left join geofences eg on eg.id = d.end_geofence_id
  left join positions sp on sp.id = d.start_position_id
  left join positions ep on ep.id = d.end_position_id
  where d.car_id = $car_id ${incomplete ? "" : "and d.end_date is not null"} and ${cond}
  order by d.start_date desc, d.id desc
  ${lim}
),
rr as (
  select p.drive_id,
         sum(case when p.battery_level - p.usable_battery_level > 0 then 1 else 0 end)::numeric / count(*) > 0.25 as reduced
  from positions p
  where p.car_id = $car_id
    and p.ideal_battery_range_km is not null
    and p.date >= (select min(start_date) from d0)
    and p.date <= (select max(coalesce(end_date, start_date + interval '1 day')) from d0)
    and p.drive_id in (select id from d0)
  group by p.drive_id
)
select
  d0.id, d0.start_date, d0.end_date, d0.duration_min,
  convert_km(d0.distance::numeric, '$length_unit') as distance,
  d0.start_place, d0.end_place, d0.start_soc, d0.end_soc,
  d0.range_diff * d0.car_efficiency as energy,
  d0.range_diff * d0.car_efficiency * 1000 / nullif(convert_km(d0.distance::numeric, '$length_unit'), 0) as consumption,
  convert_km(d0.speed_max::numeric, '$length_unit') as speed_max,
  convert_km((d0.distance / nullif(coalesce(nullif(d0.duration_min, 0) * 60, extract(epoch from d0.end_date - d0.start_date)), 0) * 3600)::numeric, '$length_unit') as speed_avg,
  d0.power_max,
  convert_celsius(d0.outside_temp_avg, '$temp_unit') as outside_temp,
  round(convert_m(d0.ascent, '$alternative_length_unit')) as ascent,
  round(convert_m(d0.descent, '$alternative_length_unit')) as descent,
  coalesce(rr.reduced, false) as reduced_range,
  d0.distance * d0.car_efficiency / nullif(
    d0.range_diff * d0.car_efficiency
    + 2100 * 0.85 * 9.81 * d0.descent / 3600 / 1000
    - 2100 * 9.81 * d0.ascent / 3600 / 1000, 0) as efficiency,
  d0.start_geofence_id, d0.end_geofence_id,
  d0.end_date is null as incomplete
from d0
left join rr on rr.drive_id = d0.id
order by d0.start_date desc, d0.id desc`;
}

export function driveTitle(row) {
  if (row.incomplete) return row.start_place ? `${row.start_place} → ？` : "没有结束的行程";
  return `${row.start_place || UNKNOWN_PLACE} → ${row.end_place || UNKNOWN_PLACE}`;
}

// 今天 / 昨天 / 9月22日（列表里不带星期，省地方）
function shortDay(ms) {
  const d = fmt.day(ms);
  return d === "今天" || d === "昨天" ? d : fmt.dateAuto(ms);
}

// 里程的小数位（各页统一）：100 以上取整，不到 100 留一位
export function lenText(v) {
  if (v == null || v === "" || !Number.isFinite(+v)) return fmt.DASH;
  // 99.96 按一位小数会写成「100.0」，这种也取整
  return fmt.len(+v, Math.abs(+v) >= 99.95 ? 0 : 1);
}

// 结束时刻：同一天只写时刻，第二天写「次日 02:52」，再往后写日期
export function endTime(start, end) {
  if (end == null) return fmt.DASH;
  const days = Math.round((dayStart(end) - dayStart(start)) / 86400e3);
  if (days <= 0) return fmt.time(end);
  if (days === 1) return `次日 ${fmt.time(end)}`;
  return fmt.dateTime(end);
}

export function timeSpan(start, end) {
  return `${fmt.time(start)}–${endTime(start, end)}`;
}

// 次要信息前面放个小图标，不用「·」隔开
function metaItem(iconName, label, text) {
  return html`<span class="tm-num">${ui.icon(iconName, { label })} ${text}</span>`;
}

// opts.date：副标题里带不带日期。按天分组的列表（组头已经有日期）传 false
export function driveItem(row, ctx, { date = true } = {}) {
  const href = ctx.href(`/stats/drives/${row.id}`);
  const when = date ? `${shortDay(row.start_date)} ` : "";

  if (row.incomplete) {
    return {
      href,
      icon: "alert-circle-outline",
      tone: "amber",
      title: driveTitle(row),
      // 标题和「未完成」标签已经说了没结束，副标题只写什么时候出发
      sub: `${when}${fmt.time(row.start_date)} 出发`,
      meta: ui.pill("未完成", "amber")
    };
  }

  // 次要信息一行放不下时整项藏起来（不截成半截字），按重要程度排：
  // 电量变化最要紧，其次气温（冬天能耗高多半是它），再次最高速度
  const meta = html`${ui.fit([
    row.start_soc != null && row.end_soc != null && metaItem("battery-50", "电量", `${row.start_soc}→${row.end_soc}%`),
    row.outside_temp != null && metaItem("thermometer", "车外平均温度", fmt.temp(row.outside_temp)),
    row.speed_max != null && metaItem("speedometer", "最高速度", fmt.speed(row.speed_max))
  ])}${row.reduced_range ? ui.pill("续航打折", "cyan", { icon: "snowflake" }) : ""}`;

  return {
    href,
    icon: "road-variant",
    // 标题核心默认最多两行：「山姆会员商店(济南高新店) → 家」这种长地名不会把终点截没
    title: driveTitle(row),
    sub: ui.fit([`${when}${timeSpan(row.start_date, row.end_date)}`, fmt.duration(row.duration_min)]),
    meta,
    value: lenText(row.distance),
    valueSub: row.consumption != null ? fmt.cons(row.consumption) : row.energy != null ? fmt.kwh(row.energy, 1) : null
  };
}

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// 按行程开始的本地日期分组，保持 rows 原来的顺序（一般是倒序）。
// 返回 [{ key, day（当天 0 点毫秒）, label（今天 / 昨天 / 9月22日 周一）, rows, count, distance, duration, energy }]
export function groupByDay(rows) {
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    const day = dayStart(r.start_date);
    let g = byKey.get(day);
    if (!g) {
      g = { key: fmt.isoDate(day), day, label: fmt.day(day), rows: [], count: 0, distance: 0, duration: 0, energy: 0 };
      byKey.set(day, g);
      groups.push(g);
    }
    g.rows.push(r);
    g.count++;
    g.distance += +r.distance || 0;
    g.duration += +r.duration_min || 0;
    g.energy += +r.energy || 0;
  }
  return groups;
}
