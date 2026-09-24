/*
 * 充电列表行：充电页、统计首页、时间线、旅程共用，保证各处的充电长得一样、点进去都是 /stats/charges/:id。
 *
 *   CHARGE_ITEM_SQL(where, { limit, offset, incomplete, empty })  一段完整 SQL（带 $car_id 等变量，直接交给 api.batch），按 start_date 倒序
 *   chargeItem(row, ctx, { date })                          一行 → ui.list 的一项
 *   groupByDay(rows)                                        按本地日期分组（充电列表的「今天 / 昨天 / 9月22日 周一」）
 *   chargeKind(row)                                         { label: 慢充 / 快充 / 超充, tone, icon }
 *   chargeState(row, now?)                                  "done" 已结束 / "charging" 正在充 / "incomplete" 中途断掉、没有结束
 *   spanText(start, end)                                    「23:06–次日 02:52」这种时间段写法（详情页也用）
 *
 * where 是额外的 WHERE 条件片段，可以用这些表别名：
 *   cp 充电（charging_processes）、a 地址（addresses）、g 地理围栏（geofences）、p 插枪时的位置点（positions）
 * 例："$__timeFilter(cp.start_date)"、"cp.id = any(array[1,2,3])"。车辆条件（cp.car_id = $car_id）已经带上了。
 * 默认不含：没有结束的充电（incomplete: true 时带上）、充进 0 kWh 的充电（empty: true 时带上）——和 Grafana「Charges」面板一样。
 *
 * 查出来的列（单位已按设置换算，页面只加单位）：
 *   id, start_date, end_date（毫秒）, duration_min, place（围栏名优先的短地名，可能为 null）, geofence_id,
 *   latitude, longitude（WGS-84）, start_soc, end_soc（%）,
 *   energy_added（充进电池的 kWh）, energy_used（从电网取的 kWh，和面板一样取 max(用电, 充入)）,
 *   cost（元，可能为 null）, cost_per_kwh（元/度，按 energy_used 算）, range_added（km/mi）,
 *   outside_temp（°C/°F，平均）, odometer（km/mi）, power_avg（kW，充入 ÷ 时长）, power_max（kW）,
 *   charge_type（'AC' | 'DC'，和面板一样按相数的众数判断）, supercharger（特斯拉超充，布尔）,
 *   incomplete（没有结束的充电：正在充，或者 TeslaMate 在充电中途停过；这时时长、电量、充入量取已记录的部分）,
 *   last_date、last_power（只有没结束的充电有：最后一条 charges 记录的时间和功率 kW，判断是不是还在充）
 */
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as fmt from "../core/format.js";
import { placeSql, UNKNOWN_PLACE } from "./_shared.js";

// 没结束的充电，最后一条记录在这么多分钟之内就算「正在充」，再久就是中途断掉了
// （TeslaMate 充电时交流约 1 分钟、直流十几秒记一条）
export const LIVE_MIN = 10;

export function CHARGE_ITEM_SQL(where, { limit, offset, incomplete = false, empty = false } = {}) {
  const cond = where && String(where).trim() ? `(${where})` : "true";
  const lim = [
    Number.isSafeInteger(limit) && limit > 0 ? `limit ${limit}` : "",
    Number.isSafeInteger(offset) && offset > 0 ? `offset ${offset}` : ""
  ].join(" ");
  // 交流 / 直流：面板的写法是相数的众数为空（直流时车不报相数）就算直流。
  // 第二个 lateral 只给没结束的充电补数（带 cp.end_date is null 的一次性过滤，正常的充电不会去扫 charges）
  return `select
  cp.id, cp.start_date, cp.end_date,
  coalesce(cp.duration_min, round(extract(epoch from ci.last_date - ci.first_date) / 60)) as duration_min,
  ${placeSql("g", "a")} as place,
  cp.geofence_id, p.latitude, p.longitude,
  coalesce(cp.start_battery_level, ci.first_soc) as start_soc,
  coalesce(cp.end_battery_level, ci.last_soc) as end_soc,
  coalesce(cp.charge_energy_added, ci.added) as energy_added,
  greatest(cp.charge_energy_used, cp.charge_energy_added) as energy_used,
  cp.cost,
  cp.cost / nullif(greatest(cp.charge_energy_added, cp.charge_energy_used), 0) as cost_per_kwh,
  convert_km((cp.end_\${preferred_range}_range_km - cp.start_\${preferred_range}_range_km)::numeric, '$length_unit') as range_added,
  convert_celsius(cp.outside_temp_avg, '$temp_unit') as outside_temp,
  convert_km(p.odometer::numeric, '$length_unit') as odometer,
  cp.charge_energy_added * 60 / nullif(cp.duration_min, 0) as power_avg,
  c.power_max,
  case when nullif(c.phases, 0) is null then 'DC' else 'AC' end as charge_type,
  coalesce(c.tesla, false) as supercharger,
  cp.end_date is null as incomplete,
  ci.last_date, ci.last_power
from charging_processes cp
left join positions p on p.id = cp.position_id
left join addresses a on a.id = cp.address_id
left join geofences g on g.id = cp.geofence_id
left join lateral (
  select max(charger_power) as power_max,
         mode() within group (order by charger_phases) as phases,
         bool_or(fast_charger_brand = 'Tesla') as tesla
  from charges where charging_process_id = cp.id
) c on true
left join lateral (
  select min(date) as first_date, max(date) as last_date, max(charge_energy_added) as added,
         (array_agg(battery_level order by date))[1] as first_soc,
         (array_agg(battery_level order by date desc))[1] as last_soc,
         (array_agg(charger_power order by date desc))[1] as last_power
  from charges where charging_process_id = cp.id and cp.end_date is null
) ci on true
where cp.car_id = $car_id
  ${incomplete ? "" : "and cp.end_date is not null"}
  ${empty ? "" : "and (cp.charge_energy_added is null or cp.charge_energy_added > 0)"}
  and ${cond}
order by cp.start_date desc, cp.id desc
${lim}`;
}

// 慢充（交流）/ 快充（直流）/ 超充（特斯拉超充站）
export function chargeKind(row) {
  if (row.charge_type === "AC") return { label: "慢充", tone: "green", icon: "ev-station" };
  if (row.supercharger) return { label: "超充", tone: "amber", icon: "lightning-bolt" };
  return { label: "快充", tone: "amber", icon: "lightning-bolt" };
}

// 没有结束时间的充电分两种：最后一条记录（一条都还没有时看开始时间）在 LIVE_MIN 分钟内的是正在充，
// 很久没有新记录的是 TeslaMate 中途停过、再也不会结束的
export function chargeState(row, now = Date.now()) {
  if (row.end_date != null && !row.incomplete) return "done";
  const last = row.last_date ?? row.start_date;
  return last != null && now - last <= LIVE_MIN * 60e3 ? "charging" : "incomplete";
}

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// 结束时刻：同一天只写时刻，第二天写「次日 02:52」，再往后写日期（和时间线一样）
function endText(start, end) {
  if (dayStart(end) === dayStart(start)) return fmt.time(end);
  // 夏令时那天一天是 25 小时
  if (dayStart(end) - dayStart(start) <= 25 * 3600e3) return `次日 ${fmt.time(end)}`;
  return fmt.dateTime(end);
}

// 「18:09–20:21」「23:06–次日 02:52」
export function spanText(start, end) {
  if (start == null) return null;
  return end == null ? fmt.time(start) : `${fmt.time(start)}–${endText(start, end)}`;
}

// 今天 / 昨天 / 9月22日（列表里不带星期，省地方；和行程列表一致）
function shortDay(ms) {
  const d = fmt.day(ms);
  return d === "今天" || d === "昨天" ? d : fmt.dateAuto(ms);
}

// 电量变化，列表里的紧凑写法「72→90%」
function socText(row) {
  return row.start_soc != null && row.end_soc != null ? `${row.start_soc}→${row.end_soc}%` : null;
}

// opts.date：副标题里带不带日期。按天分组的列表（组头已经有日期）传 false
export function chargeItem(row, ctx, { date = true } = {}) {
  const href = ctx.href(`/stats/charges/${row.id}`);
  const when = date ? `${shortDay(row.start_date)} ` : "";
  const title = row.place || UNKNOWN_PLACE;
  const soc = socText(row);
  const socHtml = soc ? html`<span class="tm-num">${soc}</span>` : "";
  const state = chargeState(row);

  if (state !== "done") {
    const live = state === "charging";
    const kind = chargeKind(row);
    return {
      href,
      icon: live ? kind.icon : "alert-circle-outline",
      tone: live ? "green" : "amber",
      title,
      // 副标题放不下时先藏后面的时长（ui.fit 整项隐藏，不截成半截字）
      sub: ui.fit([
        `${when}${fmt.time(row.start_date)} 开始`,
        row.duration_min > 0 && `${live ? "已充" : "记录了"} ${fmt.duration(row.duration_min)}`
      ]),
      meta: html`${ui.pill(live ? "充电中" : "未完成", live ? "green" : "amber")}${socHtml}`,
      value: row.energy_added != null ? fmt.kwh(row.energy_added, 1) : null,
      // 正在充时右下角是此刻的功率
      valueSub: live && row.last_power > 0 ? fmt.kw(row.last_power) : null
    };
  }

  const kind = chargeKind(row);
  // 最大功率放进类型标签里（「慢充 7 kW」「超充 251 kW」）：手机上一行放得下，也一眼看出是什么桩
  const peak = row.power_max > 0 ? ` ${fmt.kw(row.power_max)}` : "";

  return {
    href,
    icon: kind.icon,
    tone: kind.tone,
    title,
    // 时间段最要紧，其次时长：窄屏上放不下时整项藏掉时长
    sub: ui.fit([`${when}${spanText(row.start_date, row.end_date)}`, fmt.duration(row.duration_min)]),
    meta: html`${ui.pill(kind.label + peak, kind.tone)}${socHtml}`,
    value: fmt.kwh(row.energy_added, 1),
    // 费用为空很常见（公共桩没填、TeslaMate 没配单价），写明「未计费」比一个「—」好懂
    valueSub: row.cost != null ? fmt.money(row.cost) : "未计费"
  };
}

// 按充电开始的本地日期分组，保持 rows 原来的顺序（一般是倒序）。
// 返回 [{ key, day（当天 0 点毫秒）, label（今天 / 昨天 / 9月22日 周一）, rows, count, energy（充入 kWh）, cost（元，都没费用时为 null）, duration }]
export function groupByDay(rows) {
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    const day = dayStart(r.start_date);
    let g = byKey.get(day);
    if (!g) {
      g = { key: fmt.isoDate(day), day, label: fmt.day(day), rows: [], count: 0, energy: 0, cost: null, duration: 0 };
      byKey.set(day, g);
      groups.push(g);
    }
    g.rows.push(r);
    g.count++;
    // 库里是两位小数，按分取整再累加，免得 0.1 + 0.2 这类浮点误差让四舍五入差一位
    g.energy = Math.round((g.energy + (+r.energy_added || 0)) * 100) / 100;
    g.duration += +r.duration_min || 0;
    if (r.cost != null) g.cost = Math.round(((g.cost || 0) + +r.cost) * 100) / 100;
  }
  return groups;
}
