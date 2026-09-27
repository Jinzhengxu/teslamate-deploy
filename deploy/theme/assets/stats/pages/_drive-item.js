/*
 * 行程列表行：行程页、统计首页、时间线、旅程共用，保证各处的行程长得一样、点进去都是 /stats/drives/:id。
 *
 *   DRIVE_ITEM_SQL(where, { limit, offset, incomplete })  一段完整 SQL（带 $car_id 等变量，直接交给 api.batch），按 start_date 倒序
 *   driveItem(row, ctx, { date })                  一行 → ui.list 的一项
 *   groupByDay(rows)                               按本地日期分组（行程列表的「今天 / 昨天 / 9月22日 周一」）
 *   driveTitle(row)                                「家 → 公司」
 *   metaItem(icon, label, text)                    列表行次要信息的一项：小图标 + 数字（时间线也用）
 *   lenText / lenDigits / timeSpan / endTime       里程小数位、时间段的写法，在 core/format.js（各页统一）；这里再导出一次，
 *                                                  已经从这里导入的页面不用改
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
 *   ascent, descent（m 或 ft）, reduced_range（冷车续航打折，布尔；没结束的行程总是 false）,
 *   efficiency（续航达成率，按爬升 / 下降修正，1 = 100%）, start_geofence_id, end_geofence_id,
 *   state（done 已结束 / driving 正在行驶 / incomplete 中途断掉：没有 end_date 的行程分这两种，口径见 _shared.js driveStateSql）,
 *   last_date（只有正在行驶的有：最新一个带续航的位置点，毫秒）
 * 耗电、能耗、续航达成率的算法和 Grafana「Drives」面板的表格一样（续航差 × 车辆能效）。
 */
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as fmt from "../core/format.js";
import { placeSql, UNKNOWN_PLACE, driveStateSql, statePill } from "./_shared.js";
export { lenDigits, lenText, timeSpan, endTime } from "../core/format.js";

export function DRIVE_ITEM_SQL(where, { limit, offset, incomplete = false } = {}) {
  const cond = where && String(where).trim() ? `(${where})` : "true";
  const lim = [
    Number.isSafeInteger(limit) && limit > 0 ? `limit ${limit}` : "",
    Number.isSafeInteger(offset) && offset > 0 ? `offset ${offset}` : ""
  ].join(" ");
  // 冷车续航打折（面板的 ❄ 列）：行程里超过 1/4 的位置点可用电量比显示电量低。
  // 只看有续航读数的点（streaming 推送点没有），和面板一样；用 (car_id, date) 的索引按时间段取，再按行程过滤。
  // 只算已结束的行程：没结束的列表行不显示这个标记，而把它们算进时间段的话，一次很久以前中途断掉的行程
  // 就会让行程列表顶上「未完成的行程」那条查询每次都把这些年的位置点扫一遍
  return `with d0 as (
  select
    d.id, d.start_date, d.end_date, d.duration_min, d.distance,
    d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km as range_diff,
    d.speed_max, d.power_max, d.outside_temp_avg, d.ascent, d.descent,
    d.start_geofence_id, d.end_geofence_id,
    sp.battery_level as start_soc, ep.battery_level as end_soc,
    c.efficiency as car_efficiency,
    ${placeSql("sg", "sa")} as start_place,
    ${placeSql("eg", "ea")} as end_place,
    ${driveStateSql("d")} as state
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
    and p.date >= (select min(start_date) from d0 where end_date is not null)
    and p.date <= (select max(end_date) from d0)
    and p.drive_id in (select id from d0 where end_date is not null)
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
  d0.state,
  -- 正在行驶的「已开多久」算到最新的位置点（没结束的行程 duration_min 是空的）；从出发时刻往后找，走 (car_id, date) 的索引
  case when d0.state = 'driving' then (
    select max(p.date) from positions p
    where p.car_id = $car_id and p.ideal_battery_range_km is not null and p.date >= d0.start_date and p.drive_id = d0.id
  ) end as last_date
from d0
left join rr on rr.drive_id = d0.id
order by d0.start_date desc, d0.id desc`;
}

// 没结束的行程一般没有起终点（TeslaMate 结束时才按位置点补上），只有开始时间：
// 正在行驶的写「正在路上」，中途断掉的写「没有结束的行程」；有起点的终点写「行驶中 / 没有结束记录」，和详情页路线卡片的写法一样
// （写成「家 → ？」像是数据坏了，读屏也会念成「问号」）
export function driveTitle(row) {
  if (row.end_date == null) {
    const live = row.state === "driving";
    if (row.start_place) return `${row.start_place} → ${live ? "行驶中" : "没有结束记录"}`;
    return live ? "正在路上" : "没有结束的行程";
  }
  return `${row.start_place || UNKNOWN_PLACE} → ${row.end_place || UNKNOWN_PLACE}`;
}

// 次要信息前面放个小图标，不用「·」隔开
export function metaItem(iconName, label, text) {
  return html`<span class="tm-num">${ui.icon(iconName, { label })} ${text}</span>`;
}

// opts.date：副标题里带不带日期。按天分组的列表（组头已经有日期）传 false
export function driveItem(row, ctx, { date = true } = {}) {
  const href = ctx.href(`/stats/drives/${row.id}`);
  const when = date ? `${fmt.shortDay(row.start_date)} ` : "";

  if (row.state === "driving") {
    return {
      href,
      icon: "road-variant",
      tone: "accent",
      title: driveTitle(row),
      // 已开多久算到最新的位置点；刚出发、还没有位置点时只写出发时刻
      sub: ui.fit([
        `${when}${fmt.time(row.start_date)} 出发`,
        row.last_date > row.start_date && `已开 ${fmt.duration((row.last_date - row.start_date) / 60e3)}`
      ]),
      meta: statePill("driving")
    };
  }

  if (row.end_date == null) {
    return {
      href,
      icon: "alert-circle-outline",
      tone: "amber",
      title: driveTitle(row),
      // 标题和「未完成」标签已经说了没结束，副标题只写什么时候出发
      sub: `${when}${fmt.time(row.start_date)} 出发`,
      meta: statePill("incomplete")
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
    // 和充电行一样：带日期的跨夜时间段放不下一行时从「–」后面折行
    sub: ui.fit([ui.spanWrap(row.start_date, row.end_date, when), fmt.duration(row.duration_min)], { wrap: true }),
    meta,
    value: fmt.lenText(row.distance),
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
