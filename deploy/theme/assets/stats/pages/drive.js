// 行程详情（对应 Grafana「Drive Details」面板 zm7wN6Zgz）：
// 地图 + 路线、统计（面板底部 More Details 那一排 stat）、曲线（Drive / Elevation / Temperatures / Tire Pressure / Speed Histogram）。
// 面板按行程的起止时间取位置点（from = 开始时间向下取整到秒，to = 结束时间向上取整到秒），这里照做，数字才能对上。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import * as map from "../core/map.js";
import { DRIVE_ITEM_SQL, driveTitle, lenText, timeSpan, endTime } from "./_drive-item.js";
import { placeSql, placeFullSql, UNKNOWN_PLACE } from "./_shared.js";

export const title = "行程详情";
export const range = null;
export const css = true;

// ---------------------------------------------------------------- SQL（id 已经过 api.int 校验）

// 行程本身。耗电 / 能耗 / 续航达成率和面板（以及行程列表）一样按续航差 × 车辆能效算
const DRIVE_SQL = (id) => `select
  d.id, d.start_date, d.end_date, d.end_date is null as incomplete,
  extract(epoch from d.end_date - d.start_date) as seconds,
  d.duration_min,
  convert_km(d.distance::numeric, '$length_unit') as distance,
  round(convert_km(d.start_km::numeric, '$length_unit')) as odo_start,
  round(convert_km(d.end_km::numeric, '$length_unit')) as odo_end,
  convert_km(d.speed_max::numeric, '$length_unit') as speed_max,
  d.power_max, d.power_min,
  convert_celsius(d.outside_temp_avg, '$temp_unit') as outside_temp,
  convert_celsius(d.inside_temp_avg, '$temp_unit') as inside_temp,
  sp.battery_level as start_soc, ep.battery_level as end_soc,
  sp.usable_battery_level as start_usable, ep.usable_battery_level as end_usable,
  convert_km(d.start_\${preferred_range}_range_km, '$length_unit') as start_range,
  convert_km(d.end_\${preferred_range}_range_km, '$length_unit') as end_range,
  (d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency as energy,
  (d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency * 1000
    / nullif(convert_km(d.distance::numeric, '$length_unit'), 0) as consumption,
  d.distance * c.efficiency / nullif(
    (d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency
    + 2100 * 0.85 * 9.81 * d.descent / 3600 / 1000
    - 2100 * 9.81 * d.ascent / 3600 / 1000, 0) as efficiency,
  ${placeSql("sg", "sa")} as start_place,
  ${placeSql("eg", "ea")} as end_place,
  ${placeFullSql("sg", "sa")} as start_full,
  ${placeFullSql("eg", "ea")} as end_full,
  d.start_geofence_id, d.end_geofence_id,
  sp.latitude as start_lat, sp.longitude as start_lng, ep.latitude as end_lat, ep.longitude as end_lng
from drives d
join cars c on c.id = d.car_id
left join addresses sa on sa.id = d.start_address_id
left join addresses ea on ea.id = d.end_address_id
left join geofences sg on sg.id = d.start_geofence_id
left join geofences eg on eg.id = d.end_geofence_id
left join positions sp on sp.id = d.start_position_id
left join positions ep on ep.id = d.end_position_id
where d.id = ${id} and d.car_id = $car_id`;

// 面板的 Elevation Summary 和 Ø Speed：行程时间段里所有位置点的海拔差累加、车速平均（不是 距离 ÷ 时间）。
// 顺便算出这个时间段（毫秒），后面取曲线用；没结束的行程用它最后一个位置点当结束
const RANGE_SQL = (id) => `with me as (
  select date_trunc('second', d.start_date) as t0,
         to_timestamp(ceil(extract(epoch from coalesce(d.end_date,
           (select max(p.date) from positions p where p.drive_id = d.id), d.start_date)))) at time zone 'UTC' as t1
  from drives d where d.id = ${id} and d.car_id = $car_id
),
h as (
  select p.date, p.elevation - lag(p.elevation) over (order by p.date) as diff, p.speed, p.battery_level, p.odometer
  from positions p, me
  where p.car_id = $car_id and p.date between me.t0 and me.t1
)
select
  (select extract(epoch from t0) * 1000 from me) as from_ts,
  (select extract(epoch from t1) * 1000 from me) as to_ts,
  (select round(convert_m(sum(diff), '$alternative_length_unit')::numeric) from h where diff > 0) as up,
  (select round(convert_m(sum(diff), '$alternative_length_unit')::numeric) from h where diff < 0) as down,
  (select convert_km(avg(speed)::numeric, '$length_unit') from h) as speed_avg,
  (select count(*) from h) as points,
  -- 下面几项只给没结束的行程用：它没有起终点位置，电量和已开的距离只能从记录到的点里看
  (select battery_level from h where battery_level is not null order by date limit 1) as first_soc,
  (select battery_level from h where battery_level is not null order by date desc limit 1) as last_soc,
  (select round(convert_km(min(odometer)::numeric, '$length_unit')) from h) as first_odo,
  (select convert_km((max(odometer) - min(odometer))::numeric, '$length_unit') from h) as odo_dist`;

// 面板的 Energy recovered：只有间隔不到 1.5 秒的点（streaming 数据）才算，轮询数据算不出来（NULL）
const RECOVERED_SQL = (id) => `with data as (
  select p.power, extract(second from p.date - lag(p.date) over (order by p.date)) as seconds
  from positions p
  where p.drive_id = ${id} and p.car_id = $car_id and p.power < 0
)
select sum(power * (seconds / 3600)) * -1 as kwh from data where seconds is not null and seconds < 1.5`;

// 面板的 Speed Histogram：按 10 km/h（或 mph）一档，每档占行程时长的百分比。
// 没结束的行程没有 end_date（面板上全是空），用最后一个位置点当结束，不然每档都是 0%
const HIST_SQL = (id) => `select
  speed_section as speed,
  sum(seconds_elapsed) * 100 / nullif(max(duration), 0) as pct,
  sum(seconds_elapsed) as seconds
from (
  select
    round(convert_km(p.speed::numeric, '$length_unit') / 10, 0) * 10 as speed_section,
    extract(epoch from (lead(p.date) over (order by p.date) - p.date)) as seconds_elapsed,
    extract(epoch from (coalesce(d.end_date, max(p.date) over ()) - d.start_date)) as duration
  from drives d
  join positions p on p.drive_id = d.id
  where d.id = ${id} and d.car_id = $car_id
) as drivedata
where speed_section > 0
group by 1
order by 1`;

// 上一次 / 下一次（同一辆车、已结束的行程）
const NEIGHBOR_WHERE = (id) => `d.id in (
  (select x.id from drives x join drives me on me.id = ${id}
   where x.car_id = me.car_id and x.end_date is not null and (x.start_date, x.id) < (me.start_date, me.id)
   order by x.start_date desc, x.id desc limit 1)
  union all
  (select x.id from drives x join drives me on me.id = ${id}
   where x.car_id = me.car_id and x.end_date is not null and (x.start_date, x.id) > (me.start_date, me.id)
   order by x.start_date, x.id limit 1))`;

// 逐点数据分两份：轨迹 / 速度 / 功率 / 海拔要每个点（streaming 时一秒一个）；
// 电量、续航、温度、胎压只有完整记录才有（streaming 推送点这些是空的），只取那些行，省流量
const TRACK_SQL = `select date, latitude, longitude,
  convert_km(speed::numeric, '$length_unit') as speed,
  power,
  round(convert_m(elevation, '$alternative_length_unit')) as elevation
from positions
where car_id = $car_id and $__timeFilter(date)
order by date`;

const DETAIL_SQL = `select date, battery_level, usable_battery_level,
  convert_km(\${preferred_range}_battery_range_km, '$length_unit') as range,
  convert_km(est_battery_range_km, '$length_unit') as range_est,
  battery_heater,
  convert_celsius(outside_temp, '$temp_unit') as outside_temp,
  convert_celsius(inside_temp, '$temp_unit') as inside_temp,
  convert_celsius(driver_temp_setting, '$temp_unit') as driver_temp,
  convert_celsius(passenger_temp_setting, '$temp_unit') as passenger_temp,
  is_climate_on, fan_status,
  convert_tire_pressure(tpms_pressure_fl, '$pressure_unit') as fl,
  convert_tire_pressure(tpms_pressure_fr, '$pressure_unit') as fr,
  convert_tire_pressure(tpms_pressure_rl, '$pressure_unit') as rl,
  convert_tire_pressure(tpms_pressure_rr, '$pressure_unit') as rr
from positions
where car_id = $car_id and $__timeFilter(date)
  and (ideal_battery_range_km is not null or outside_temp is not null or tpms_pressure_fl is not null)
order by date`;

// ---------------------------------------------------------------- 格式化小工具

// 行程用时精确到秒（面板的 Drive Duration 也是）：17分30秒 / 1小时5分
function durSec(sec) {
  if (sec == null || !Number.isFinite(+sec)) return fmt.DASH;
  const s = Math.round(+sec);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60 ? (s % 60) + "秒" : ""}`;
  // 一小时以上只到分钟，按钟表的走法向下取整（3:20:53 是「3小时20分」）
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h >= 24 ? fmt.duration(s / 60) : `${h}小时${m ? m + "分" : ""}`;
}

// 变化很小的曲线（短途的电量只差 1%、胎压只差 0.1 bar）让坐标轴至少跨 span，不然一格的变化看着像断崖
function atLeast(values, span, { lo = -Infinity, hi = Infinity, step } = {}) {
  const v = values.filter((x) => x != null && Number.isFinite(+x)).map(Number);
  if (!v.length) return {};
  const a = Math.min(...v);
  const b = Math.max(...v);
  if (b - a >= span) return { scale: true };
  const unit = step || span / 4;
  let min = Math.floor(((a + b) / 2 - span / 2) / unit) * unit;
  min = Math.max(lo, Math.min(min, hi - span));
  let max = min + span;
  if (max < b) (max = Math.ceil(b / unit) * unit), (min = max - span);
  return { min: +min.toFixed(4), max: +max.toFixed(4) };
}

function signed(v, f) {
  if (v == null || !Number.isFinite(+v)) return "";
  return (+v > 0 ? "+" : +v < 0 ? "−" : "±") + f(Math.abs(+v));
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const id = api.int(ctx.params.id, { min: 1, max: 2147483647 });
  ui.render(ctx.root, ui.skeleton(["map", "stats", "kv"]));

  const d = await api.batch(
    {
      drive: DRIVE_SQL(id),
      rng: RANGE_SQL(id),
      recovered: RECOVERED_SQL(id),
      hist: HIST_SQL(id),
      nb: DRIVE_ITEM_SQL(NEIGHBOR_WHERE(id))
    },
    { signal: ctx.signal }
  );

  const r = d.drive[0];
  if (!r) {
    ctx.setTitle("找不到这次行程");
    ui.render(
      ctx.root,
      ui.card(
        ui.empty(`没有编号 ${id} 的行程。可能已经删除，或者是另一辆车的。`, {
          icon: "road-variant",
          title: "找不到这次行程",
          action: ui.button("回到行程列表", { href: ctx.href("/stats/drives"), kind: "soft" })
        })
      )
    );
    return;
  }

  const rg = d.rng[0] || {};
  // 页头「在 Grafana 中打开」：Drive Details 面板靠时间范围取数据（默认只看最近 12 小时），带上这次行程的起止
  if (rg.from_ts && rg.to_ts) ctx.setGrafanaVars({ from: rg.from_ts, to: rg.to_ts });
  const recovered = d.recovered[0] ? d.recovered[0].kwh : null;
  const prev = d.nb.find((x) => x.start_date < r.start_date || (x.start_date === r.start_date && x.id < r.id));
  const next = d.nb.find((x) => x !== prev);
  // 只有开始、结束同一刻这种坏数据时占比算不出来（全是 NULL），那就不画
  const hasHist = d.hist.some((x) => x.pct > 0);

  // 页头标题是单行的，「日期 起点 → 终点」长了会把终点截没：标题只写日期（和充电详情一样），起终点看下面的路线卡
  ctx.setTitle(`${fmt.dateAuto(r.start_date)}的行程`);

  ui.render(
    ctx.root,
    html`
      <div class="pg-drive-layout">
        <div class="pg-drive-mapcol">${ui.card(ui.mapBox("pg-drive-map"), { pad: false })}</div>
        <div class="pg-drive-main">
          ${r.incomplete ? incompleteNote() : ""}
          ${ui.card(routeBlock(r), { pad: false })}
          ${r.incomplete
            ? ui.card(incompleteKv(r, rg), { title: "已记录的部分" })
            : html`${mainStats(r, rg)}${ui.card(detailKv(r, rg, recovered), { title: "详细数据" })}`}
          <div class="pg-drive-charts" id="pg-drive-charts">${ui.skeleton("chart", { height: 200 })}</div>
          ${hasHist ? histCard() : ""}
          ${neighbors(prev, next, ctx)}
          <div class="pg-drive-foot">
            ${ui.button("导出 GPX 轨迹", { href: `/drive/${id}/gpx`, kind: "soft", icon: "map-marker-path", small: true, attrs: { download: true } })}
          </div>
        </div>
      </div>
    `
  );

  // ---- 逐点数据：主内容画出来之后再取（长途、streaming 的行程有上万个点）。速度分布不用等它，先画
  const range = { from: rg.from_ts, to: rg.to_ts };
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
  const hist = hasHist ? drawHist(ctx, d.hist) : null;
  let mapInst = null;
  // 这一步出错只在曲线的位置显示错误和「重试」，上面已经画好的数字留着
  const loadPoints = async () => {
    const box = ctx.root.querySelector("#pg-drive-charts");
    let pts;
    try {
      pts = await api.batch({ track: TRACK_SQL, detail: DETAIL_SQL }, { signal: ctx.signal, range });
    } catch (e) {
      if (e.name === "AbortError" || e.auth) throw e;
      ui.render(box, ui.card(ui.error(e, () => {
        ui.render(box, ui.skeleton("chart", { height: 200 }));
        loadPoints().catch(() => {});
      })));
      return;
    }
    if (!mapInst) mapInst = await drawMap(ctx, r, pts.track);
    await drawCharts(ctx, r, range, pts, mapInst);
  };
  await Promise.all([loadPoints(), hist]);
}

// ---------------------------------------------------------------- 上半部分

function incompleteNote() {
  return ui.card(
    html`<div class="pg-drive-warn">
      ${ui.icon("alert-circle-outline")}
      <div>
        <strong>这次行程没有结束记录</strong>
        <p class="tm-note">TeslaMate 在行程中途停止过，只留下了开始时间和前面的一段轨迹，所以没有距离、耗电这些汇总。
          可以照官方文档<a href="https://docs.teslamate.org/docs/maintenance/manually_fixing_data" target="_blank" rel="noopener">手动修复数据</a>。</p>
      </div>
    </div>`,
    { cls: "pg-drive-warn-card" }
  );
}

// 起终点：完整地址 + 时间 + 收藏点链接（面板表格里地址那一列的「Create or edit geo-fence」）
function routeBlock(r) {
  const fence = (gid, lat, lng) => {
    if (gid) return html`<a class="pg-drive-fence" href="/geo-fences/${+gid}/edit">${ui.icon("map-marker")}编辑收藏点</a>`;
    if (lat == null || lng == null) return "";
    const q = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    return html`<a class="pg-drive-fence" href="/geo-fences/new?${q.toString()}">${ui.icon("map-marker")}设为收藏点</a>`;
  };
  const stop = (kind, name, full, time, link) => html`<li class="pg-drive-stop is-${kind}">
    <span class="pg-drive-dot" aria-hidden="true"></span>
    <div class="pg-drive-stop-main">
      <div class="pg-drive-stop-name">${name}</div>
      ${full && full !== name ? html`<div class="pg-drive-stop-full">${full}</div>` : ""}
      ${link}
    </div>
    <time class="tm-num">${time}</time>
  </li>`;
  return html`<ol class="pg-drive-route" aria-label="路线">
    ${stop("start", r.start_place || UNKNOWN_PLACE, r.start_full, fmt.time(r.start_date), fence(r.start_geofence_id, r.start_lat, r.start_lng))}
    ${r.incomplete
      ? stop("end", "没有结束记录", null, "—", "")
      : stop("end", r.end_place || UNKNOWN_PLACE, r.end_full, endTime(r.start_date, r.end_date), fence(r.end_geofence_id, r.end_lat, r.end_lng))}
  </ol>`;
}

// 没结束的行程通常只剩开始时间和一段轨迹（没有起终点位置），电量、里程从记录到的点里取；没有的项就不列了
function incompleteKv(r, rg) {
  const soc0 = r.start_soc ?? rg.first_soc;
  const odo0 = r.odo_start ?? rg.first_odo;
  return ui.kv(
    [
      ["开始", fmt.dateTime(r.start_date)],
      ["最后一个位置点", rg.to_ts ? fmt.dateTime(rg.to_ts) : null],
      ["已记录的时长", rg.to_ts ? fmt.duration((rg.to_ts - r.start_date) / 60e3) : null],
      ["已记录的距离", rg.odo_dist != null ? `约 ${lenText(rg.odo_dist)}（按里程表）` : null],
      ["电量", soc0 != null ? html`<span class="tm-num">${soc0}% → ${rg.last_soc ?? "—"}%</span>` : null],
      ["出发时里程表", odo0 != null ? fmt.len(odo0, 0) : null],
      ["位置点", rg.points ? `${fmt.int(rg.points)} 个` : null]
    ].filter(([, v]) => v != null)
  );
}

function mainStats(r, rg) {
  const per100 = r.consumption != null && fmt.unit.len === "km" ? `${fmt.num(r.consumption / 10, 1)} kWh/百公里` : null;
  const used = r.start_range != null && r.end_range != null ? r.start_range - r.end_range : null;
  return ui.stats(
    [
      { label: "距离", icon: "road-variant", value: fmt.num(r.distance, +r.distance >= 99.95 ? 0 : 1), unit: fmt.unit.len, sub: used != null ? `续航少了 ${fmt.len(used, 0)}` : null },
      { label: "用时", icon: "clock-outline", value: durSec(r.seconds), sub: timeSpan(r.start_date, r.end_date) },
      { label: "耗电（净）", icon: "lightning-bolt", value: fmt.num(r.energy, 1), unit: "kWh", sub: "按续航减少估算" },
      { label: "能耗（净）", icon: "leaf", value: r.consumption, unit: fmt.unit.cons, sub: per100 },
      { label: "平均速度", icon: "speedometer", value: rg.speed_avg, unit: fmt.unit.speed, sub: "位置点车速的平均" },
      { label: "最高速度", icon: "speedometer", value: r.speed_max, unit: fmt.unit.speed, sub: r.power_max != null ? `最大功率 ${fmt.kw(r.power_max)}` : null }
    ],
    { cols: 2 }
  );
}

function detailKv(r, rg, recovered) {
  const rangeLabel = api.settings && api.settings.preferredRange === "ideal" ? "续航（理想）" : "续航（表显）";
  const socDiff = r.start_soc != null && r.end_soc != null ? r.end_soc - r.start_soc : null;
  const rangeDiff = r.start_range != null && r.end_range != null ? r.end_range - r.start_range : null;
  // 冷车时可用电量比显示电量低（「续航打折」），不一样时才单独列出来
  const usableDiffers = r.start_usable != null && (r.start_usable !== r.start_soc || r.end_usable !== r.end_soc);
  const eff = r.efficiency != null && r.efficiency > 0 ? r.efficiency * 100 : null;
  return html`${ui.kv(
    [
      ["电量", r.start_soc != null ? html`<span class="tm-num">${r.start_soc}% → ${r.end_soc}%</span> <span class="tm-muted">${signed(socDiff, (v) => v + "%")}</span>` : null],
      usableDiffers && ["可用电量", html`<span class="tm-num">${r.start_usable}% → ${r.end_usable}%</span>`],
      [rangeLabel, rangeDiff != null ? html`<span class="tm-num">${fmt.len(r.start_range, 0)} → ${fmt.len(r.end_range, 0)}</span> <span class="tm-muted">${signed(rangeDiff, (v) => fmt.len(v, 0))}</span>` : null],
      ["续航达成率", eff != null ? html`<span class="tm-num${eff >= 99 ? " tm-tone-green" : eff < 65 ? " tm-tone-amber" : ""}">${fmt.pct(eff, 1)}</span>` : null],
      // 回收电量一般只有零点几 kWh，一位小数全是「0.1」，不到 1 kWh 时留两位
      ["回收电量", recovered != null ? fmt.kwh(recovered, Math.abs(recovered) < 1 ? 2 : 1) : html`<span class="tm-muted">没有 streaming 数据</span>`],
      ["爬升 / 下降", rg.up != null || rg.down != null ? html`<span class="tm-num">↑ ${fmt.alt(rg.up || 0)}　↓ ${fmt.alt(Math.abs(rg.down || 0))}</span>` : null],
      ["车外平均温度", fmt.temp(r.outside_temp)],
      ["车内平均温度", fmt.temp(r.inside_temp)],
      ["最大功率 / 回收", r.power_max != null ? html`<span class="tm-num">${fmt.kw(r.power_max)} / ${r.power_min != null && r.power_min < 0 ? fmt.kw(-r.power_min) : "—"}</span>` : null],
      ["里程表", r.odo_start != null ? html`<span class="tm-num">${fmt.len(r.odo_start, 0)} → ${fmt.len(r.odo_end, 0)}</span>` : null],
      ["开始", fmt.dateTime(r.start_date)],
      ["结束", fmt.dateTime(r.end_date)]
    ]
  )}
  <p class="tm-note pg-drive-kv-note">续航达成率 = 实际距离 ÷ 消耗的续航，已按爬升、下降修正（和 Grafana 默认的算法一样）；
    回收电量要有间隔 1.5 秒以内的 streaming 数据才算得出。</p>`;
}

// ---------------------------------------------------------------- 上一次 / 下一次

function neighbors(prev, next, ctx) {
  const cell = (row, dir) => {
    const label = dir < 0 ? "上一次" : "下一次";
    if (!row) return html`<div class="pg-drive-nav-cell is-empty"><span class="pg-drive-nav-label">${label}</span><span class="tm-muted">${dir < 0 ? "没有更早的行程" : "这是最近的一次"}</span></div>`;
    return html`<a class="pg-drive-nav-cell${dir > 0 ? " is-next" : ""}" href="${ctx.href(`/stats/drives/${row.id}`)}" rel="${dir < 0 ? "prev" : "next"}">
      <span class="pg-drive-nav-label">${dir < 0 ? ui.icon("chevron-left") : ""}${label}${dir > 0 ? ui.icon("chevron-right") : ""}</span>
      <span class="pg-drive-nav-title">${driveTitle(row)}</span>
      ${ui.segs([`${fmt.dateAuto(row.start_date)} ${fmt.time(row.start_date)}`, lenText(row.distance)], { cls: "pg-drive-nav-sub tm-num" })}
    </a>`;
  };
  return html`<nav class="pg-drive-nav" aria-label="上一次和下一次行程">${cell(prev, -1)}${cell(next, 1)}</nav>`;
}

// ---------------------------------------------------------------- 地图

async function drawMap(ctx, r, track) {
  const el = ctx.root.querySelector("#pg-drive-map");
  const pts = track.map((p) => [p.latitude, p.longitude]);
  const m = await map.create(el);
  if (!m) return null;
  if (!pts.length) {
    if (r.start_lat != null) {
      map.marker(m, [r.start_lat, r.start_lng], { kind: "start", title: "出发" });
      m.setView(map.gcj(r.start_lat, r.start_lng), 14);
    }
    return m;
  }
  const line = map.track(m, pts, { color: "accent" });
  map.marker(m, pts[0], { kind: "start", title: `出发：${r.start_place || UNKNOWN_PLACE}` });
  // 没结束的行程，最后一个点不是终点，画成圆点
  if (pts.length > 1) {
    map.marker(m, pts[pts.length - 1], r.incomplete ? { kind: "dot", title: "最后记录的位置" } : { kind: "end", title: `到达：${r.end_place || UNKNOWN_PLACE}` });
  }
  map.fit(m, [line]);
  return m;
}

// 图上移动时，地图上标出那一刻车在哪（最近的轨迹点）。返回 show(ms | null)
function linkMap(m, track) {
  if (!m || !track.length) return () => {};
  const cur = map.cursor(m);
  const pts = track.map((p) => [p.date, p.latitude, p.longitude]);
  return (t) => {
    const p = t == null ? null : chart.nearest(pts, t);
    if (p) cur.show([p[1], p[2]]);
    else cur.hide();
  };
}

// ---------------------------------------------------------------- 曲线

function chartCard(id, titleText, { height = 220, heightMobile = 190, legend } = {}) {
  return ui.card(html`${legend || ""}${ui.chartBox(id, { height, heightMobile, label: titleText })}`, { title: titleText });
}

// 开 / 关的量（空调、电池加热）：面板里是隐藏坐标轴上一条 0/1 的线，这里画成「开」时的一段底色，
// 图例里能点掉，提示框里显示开 / 关
function flagSeries(name, rows, key, color, yAxisIndex) {
  return {
    type: "line",
    name,
    data: rows.filter((p) => p[key] != null).map((p) => [p.date, p[key] ? 1 : 0]),
    yAxisIndex,
    step: "end",
    showSymbol: false,
    lineStyle: { width: 0 },
    itemStyle: { color: `@${color}` },
    areaStyle: { color: `@${color}/0.1` },
    tooltip: { valueFormatter: (v) => (v ? "开" : "关") },
    z: 0
  };
}

// 藏起来的 0~1 坐标轴，给上面那种底色用
const FLAG_AXIS = { type: "value", show: false, min: 0, max: 1 };

async function drawCharts(ctx, r, range, pts, m) {
  const box = ctx.root.querySelector("#pg-drive-charts");
  if (!box) return;
  const track = pts.track;
  const det = pts.detail;
  const hasTemp = det.some((p) => p.outside_temp != null || p.inside_temp != null);
  const tpms = det.filter((p) => p.fl != null);
  const hasPower = track.some((p) => p.power != null);
  const hasElev = track.some((p) => p.elevation != null);
  const hasBattery = det.some((p) => p.battery_level != null || p.range != null);

  if (!track.length && !det.length) {
    ui.render(box, ui.card(ui.empty("这次行程没有记录到位置点。", { icon: "chart-line", title: "没有曲线" })));
    return;
  }

  const hasHeater = det.some((p) => p.battery_heater === true);
  const passengerDiffers = det.some((p) => p.passenger_temp != null && p.passenger_temp !== p.driver_temp);

  ui.render(
    box,
    html`
      ${track.length ? chartCard("pg-drive-speed", hasPower ? "速度与功率" : "速度") : ""}
      ${hasBattery ? chartCard("pg-drive-battery", "电量与续航", { heightMobile: 210 }) : ""}
      ${hasElev ? chartCard("pg-drive-elev", "海拔", { height: 200, heightMobile: 170 }) : ""}
      ${hasTemp ? chartCard("pg-drive-temp", "温度") : ""}
      ${tpms.length ? chartCard("pg-drive-tpms", "胎压", { height: 200, heightMobile: 180 }) : ""}
    `
  );

  const xAxis = chart.timeAxis({ min: range.from, max: range.to });
  const t = (key, rows) => rows.filter((p) => p[key] != null).map((p) => [p.date, p[key]]);
  const jobs = [];

  if (track.length) {
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-drive-speed"), {
        xAxis,
        yAxis: [
          chart.valueAxis({ unit: fmt.unit.speed, min: 0 }),
          chart.valueAxis({ unit: "kW", position: "right", splitLine: { show: false }, show: hasPower })
        ],
        series: [
          chart.line("车速", t("speed", track), { color: "c1", area: true, fmt: (v) => fmt.speed(v) }),
          hasPower && chart.line("功率", t("power", track), { color: "c2", yAxisIndex: 1, width: 1.5, fmt: (v) => fmt.kw(v) })
        ].filter(Boolean),
        dataZoom: chart.zoom()
      })
    );
  }

  if (hasBattery) {
    const series = [
      chart.line("电量", t("battery_level", det), { color: "c4", fmt: (v) => fmt.pct(v) }),
      det.some((p) => p.usable_battery_level != null && p.usable_battery_level !== p.battery_level) &&
        chart.line("可用电量", t("usable_battery_level", det), { color: "c4", dashed: true, width: 1.5, fmt: (v) => fmt.pct(v) }),
      chart.line(api.settings.preferredRange === "ideal" ? "理想续航" : "表显续航", t("range", det), { color: "c1", yAxisIndex: 1, fmt: (v) => fmt.len(v, 0) }),
      chart.line("估算续航", t("range_est", det), { color: "c3", yAxisIndex: 1, dashed: true, width: 1.5, fmt: (v) => fmt.len(v, 0) }),
      hasHeater && flagSeries("电池加热", det, "battery_heater", "c6", 2)
    ].filter(Boolean);
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-drive-battery"), {
        xAxis,
        yAxis: [
          chart.valueAxis({ unit: "%", minInterval: 1, ...atLeast(det.flatMap((p) => [p.battery_level, p.usable_battery_level]), 8, { lo: 0, hi: 100, step: 2 }) }),
          chart.valueAxis({ unit: fmt.unit.len, position: "right", scale: true, splitLine: { show: false } }),
          FLAG_AXIS
        ],
        // 冬天多出「可用电量」「电池加热」两项，手机上一行放不下：图例换行（不用翻页），图往下让一行
        ...(series.length > 3 && window.matchMedia("(max-width: 768px)").matches
          ? { legend: { type: "plain", itemGap: 12 }, grid: { top: 56 } }
          : {}),
        series,
        dataZoom: chart.zoom()
      })
    );
  }

  if (hasElev) {
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-drive-elev"), {
        xAxis,
        yAxis: chart.valueAxis({ unit: fmt.unit.altLen, scale: true }),
        series: [
          { ...chart.line("海拔", t("elevation", track), { color: "c5", area: true, fmt: (v) => fmt.alt(v) }), connectNulls: true }
        ],
        dataZoom: chart.zoom()
      })
    );
  }

  if (hasTemp) {
    const series = [
      chart.line("车外", t("outside_temp", det), { color: "c1", fmt: (v) => fmt.temp(v) }),
      chart.line("车内", t("inside_temp", det), { color: "c2", fmt: (v) => fmt.temp(v) }),
      chart.line(passengerDiffers ? "主驾设定" : "空调设定", t("driver_temp", det), { color: "c3", step: "end", dashed: true, width: 1.5, fmt: (v) => fmt.temp(v) }),
      passengerDiffers && chart.line("副驾设定", t("passenger_temp", det), { color: "c5", step: "end", dashed: true, width: 1.5, fmt: (v) => fmt.temp(v) }),
      // 空调开关画成底色；风量（面板里也是隐藏坐标轴上的一条线）只在提示框里显示
      det.some((p) => p.is_climate_on != null) && flagSeries("空调", det, "is_climate_on", "c5", 1),
      det.some((p) => p.fan_status != null) && {
        type: "line",
        name: "风量",
        data: t("fan_status", det),
        yAxisIndex: 2,
        step: "end",
        showSymbol: false,
        lineStyle: { width: 0 },
        itemStyle: { color: "@hint" },
        tooltip: { valueFormatter: (v) => (v ? `${v} 档` : "关") },
        silent: true
      }
    ].filter(Boolean);
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-drive-temp"), {
        xAxis,
        yAxis: [
          chart.valueAxis({ unit: fmt.unit.temp, scale: true }),
          FLAG_AXIS,
          { type: "value", show: false, min: 0, max: 20 }
        ],
        legend: { data: series.filter((s) => s.name !== "风量").map((s) => s.name) },
        series,
        dataZoom: chart.zoom()
      })
    );
  }

  if (tpms.length) {
    const names = [["fl", "左前"], ["fr", "右前"], ["rl", "左后"], ["rr", "右后"]];
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-drive-tpms"), {
        xAxis,
        yAxis: chart.valueAxis({
          unit: fmt.unit.pressure,
          ...atLeast(tpms.flatMap((p) => [p.fl, p.fr, p.rl, p.rr]), fmt.unit.pressure === "psi" ? 8 : 0.4, { lo: 0 })
        }),
        series: names.map(([k, n], i) => chart.line(n, t(k, tpms), { color: `c${i + 1}`, width: 1.5, fmt: (v) => fmt.pressure(v) })),
        dataZoom: chart.zoom()
      })
    );
  }

  const insts = (await Promise.all(jobs)).filter(Boolean);
  if (!insts.length) return;

  // 图之间联动（提示框、缩放一起动），并在地图上标出当前时刻的位置
  chart.connect(insts);
  const show = linkMap(m, track);
  for (const inst of insts) {
    // 联动的图也会收到这个事件，有的不带 x 轴信息：那种不当成「移开了」，移开只看 globalout
    inst.on("updateAxisPointer", (e) => {
      const info = e.axesInfo && e.axesInfo.find((a) => a.axisDim === "x");
      if (info && Number.isFinite(+info.value)) show(+info.value);
    });
    inst.on("globalout", () => show(null));
  }
}

// ---------------------------------------------------------------- 速度分布

function histCard() {
  return ui.card(ui.chartBox("pg-drive-hist", { height: 220, heightMobile: 190, label: "速度分布" }), { title: "速度分布" });
}

// 面板的查询只返回有数据的档位；类目轴上缺的档（80 后面直接是 100）看着像连着的，补成 0
function fillBins(rows) {
  const out = [];
  const by = new Map(rows.map((x) => [Math.round(+x.speed), x]));
  const first = Math.round(+rows[0].speed);
  const last = Math.round(+rows[rows.length - 1].speed);
  if (!Number.isFinite(first) || !Number.isFinite(last) || (last - first) / 10 > 60) return rows;
  for (let v = first; v <= last; v += 10) out.push(by.get(v) || { speed: v, pct: 0, seconds: 0 });
  return out;
}

function drawHist(ctx, histRows) {
  const el = ctx.root.querySelector("#pg-drive-hist");
  const rows = fillBins(histRows);
  const minLabel = rows.length > 8 ? 5 : 1;
  const u = fmt.unit.speed;
  const hms = (s) => {
    const v = Math.round(s);
    return `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  };
  return chart.create(el, {
    xAxis: chart.categoryAxis(rows.map((x) => fmt.int(x.speed)), { name: u, nameLocation: "end", nameGap: 6, nameTextStyle: { align: "right", verticalAlign: "top", padding: [18, 0, 0, 0] } }),
    yAxis: chart.valueAxis({ unit: "%", min: 0 }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const x = rows[p.dataIndex];
      return chart.tipHtml(`${fmt.int(x.speed)} ${u} 左右`, [
        { color: p.color, name: "占行程时间", value: x.pct > 0 && x.pct < 0.5 ? "<1%" : fmt.pct(x.pct) },
        { name: "时长", value: hms(x.seconds) }
      ]);
    }),
    // 档位多（长途 10~130）时小于 5% 的柱子不标数，不然矮柱子上的「1%」「3%」挤成一团
    series: [chart.bars("占比", rows.map((x) => +(+x.pct).toFixed(2)), { color: "c1", label: (v) => (v >= minLabel ? fmt.pct(v) : "") })]
  });
}
