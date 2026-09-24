/*
 * 各页面共用的 SQL 片段和小工具。
 *
 * 地点名称：有地理围栏（家、公司）就用围栏名，否则用地址。g、a 是 SQL 里 geofences、addresses 表的别名。
 *   placeSql      短名字，列表行、标题用：地址自己的名字 → 路名门牌 → 街道 → 区县 → 城市
 *   placeFullSql  带城市，详情页用；和 Grafana 面板的写法一样，只是中文路名和门牌之间不加空格
 * 两个都可能是 NULL（没有反查到地址），页面自己显示「未知地点」。
 *
 * 没有结束时间的充电 / 行驶是正在进行，还是中途断掉了（充电页、行程页、详情页、首页、时间线、状态页共用同一个口径）：
 *   chargeState(row) / driveState(row)      已经查出最后一条记录的时间时，在 JS 里判断
 *   chargeStateSql(cp) / driveStateSql(d)   同样的判断写成 SQL 表达式：选成一列，或者放进 WHERE 按状态筛
 *   LIVE_SQL                                这辆车现在正在进行的行驶或充电
 *   statePill(state)                        「充电中 / 行驶中 / 未完成」标签
 *   FIX_DOC                                 官方文档「手动修复数据」的链接
 */
import * as ui from "../core/ui.js";

export function placeSql(g, a) {
  return `COALESCE(${g}.name, ${a}.name, NULLIF(CONCAT(${a}.road, ${a}.house_number), ''), ${a}.neighbourhood, ${a}.county, ${a}.city)`;
}

export function placeFullSql(g, a) {
  return `COALESCE(${g}.name, NULLIF(CONCAT_WS(', ', COALESCE(${a}.name, NULLIF(CONCAT(${a}.road, ${a}.house_number), '')), ${a}.city), ''))`;
}

export const UNKNOWN_PLACE = "未知地点";

// ---------------------------------------------------------------- 进行中 / 中途断掉

// TeslaMate 开始充电 / 行驶时就插入 charging_processes / drives 的一行，结束时才填 end_date。它在中途停过
// （重启、升级、崩溃）的话，重新启动后另起一行，旧的那一行就永远没有 end_date 了（Grafana 的「Incomplete Charges / Drives」）。
// 所以 end_date 为空时看最后一条记录有多新，超过下面的分钟数就算中途断掉：
//   充电：每 5～20 秒记一条 charges（功率越大越密，vehicle.ex 的 determince_interval），接口出错 15 秒后重试，
//         15 分钟没有新记录就不是偶尔失败一两次了。车在地下车库断网时 TeslaMate 也让这次充电开着、只是不再记录，
//         等车重新联网再补上结束 —— 这种断网期间也算「未完成」，联网后自己就好了。
//   行驶：每 2.5 秒（开了 streaming 是 15 秒）记一个带续航的完整位置点；车断线满 15 分钟 TeslaMate 自己就按超时结束行程
//         （@drive_timeout_min），所以 20 分钟没有新位置点、又没有结束的，只能是 TeslaMate 中途停过。
// 状态值：done 已结束 / charging 正在充电 / driving 正在行驶 / incomplete 中途断掉（数据不完整，要手动修）
export const CHARGE_LIVE_MIN = 15;
export const DRIVE_LIVE_MIN = 20;

// row 里要有 end_date、start_date、last_date（毫秒；last_date 是最后一条 charges / 位置点的时间，一条都还没有时按开始时间算）。
// 用的是浏览器的时钟，和数据库差一两分钟不要紧：阈值比记录间隔大得多
function openState(row, liveMin, live, now) {
  if (row.end_date != null) return "done";
  const last = row.last_date ?? row.start_date;
  return last != null && now - last <= liveMin * 60e3 ? live : "incomplete";
}

export function chargeState(row, now = Date.now()) {
  return openState(row, CHARGE_LIVE_MIN, "charging", now);
}

export function driveState(row, now = Date.now()) {
  return openState(row, DRIVE_LIVE_MIN, "driving", now);
}

// SQL 版，值和上面一样是状态名：`${chargeStateSql("cp")} as state`，或者 `${driveStateSql("d")} = 'driving'`。
// 只查「最近 N 分钟里有没有新记录」，不取最后一条再比：positions 的 drive_id 只有 BRIN 索引，很久以前断掉的行程
// 要从现在往回扫到那一天才找得到它的最后一个点；带续航的位置点走 (car_id, date) 的部分索引，只扫最近这一小段。
// 刚开始、还没记第一条的按开始时间算
const recent = (min) => `(now() at time zone 'UTC') - interval '${min} minutes'`;

export function chargeStateSql(cp) {
  return `case when ${cp}.end_date is not null then 'done'
  when ${cp}.start_date > ${recent(CHARGE_LIVE_MIN)}
    or exists (select 1 from charges live_c
               where live_c.charging_process_id = ${cp}.id and live_c.date > ${recent(CHARGE_LIVE_MIN)}) then 'charging'
  else 'incomplete' end`;
}

export function driveStateSql(d) {
  return `case when ${d}.end_date is not null then 'done'
  when ${d}.start_date > ${recent(DRIVE_LIVE_MIN)}
    or exists (select 1 from positions live_p
               where live_p.car_id = ${d}.car_id and live_p.ideal_battery_range_km is not null
                 and live_p.drive_id = ${d}.id and live_p.date > ${recent(DRIVE_LIVE_MIN)}) then 'driving'
  else 'incomplete' end`;
}

// 这辆车现在正在进行的行驶或充电，最多一行（两样都有时取后开始的）：kind 'drive' | 'charge'、id、start_date。
// 时间线用它把最后那段停车截到出发 / 插枪的时刻，首页、状态页用它写「正在充电」
export const LIVE_SQL = `select kind, id, start_date from (
  select 'drive' as kind, d.id, d.start_date
  from drives d
  where d.car_id = $car_id and d.end_date is null and ${driveStateSql("d")} = 'driving'
  union all
  select 'charge', cp.id, cp.start_date
  from charging_processes cp
  where cp.car_id = $car_id and cp.end_date is null and ${chargeStateSql("cp")} = 'charging'
) x
order by start_date desc
limit 1`;

// 列表行、详情页头部的状态标签用同一套字和颜色；已结束的不加标签
const STATE_PILLS = {
  charging: ["充电中", "green"],
  driving: ["行驶中", "accent"],
  incomplete: ["未完成", "amber"]
};

export function statePill(state) {
  const p = STATE_PILLS[state];
  return p ? ui.pill(p[0], p[1]) : "";
}

// 中途断掉的记录要照官方文档手动补上结束，提示里统一写「官方文档里有<a>手动修复数据</a>的方法。」
export const FIX_DOC = "https://docs.teslamate.org/docs/maintenance/manually_fixing_data";
