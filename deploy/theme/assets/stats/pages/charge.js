// 充电详情（对应 Grafana「Charge Details」BHhxFeZRz）：地点和时间 → 统计 → 功率 / 电量曲线 → 电压电流 → 充电曲线 → 上一次 / 下一次
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import * as map from "../core/map.js";
import { chargeKind, chargeState, spanText } from "./_charge-item.js";
import { placeSql, placeFullSql, UNKNOWN_PLACE } from "./_shared.js";

export const title = "充电详情";
export const range = null;
export const css = true;

// 接口类型（conn_charge_cable）的中文叫法；不认识的原样显示
const CABLES = { GB_AC: "国标交流", GB_DC: "国标直流", IEC: "Type 2", SAE: "J1772", CCS: "CCS", CCS1: "CCS1", CCS2: "CCS2", CHADEMO: "CHAdeMO", Tesla: "特斯拉" };

// 一次查询取齐这次充电的全部汇总。数字的算法照面板：
//   时长 = charges 里最后一条减第一条；充入 = 过程表的值，没有（没结束）时取 charges 里的最大值；
//   效率 = min(充入 / 用电, 1)；相数 = 面板的 determine_phases 变量；平均功率 = 按相数 × 电流 × 电压算（交流），直流用上报的功率；
//   车外温度 = charges 的平均值（面板的 Ø Outdoor Temperature）
function detailSql(id) {
  return `with c as (
  select
    min(date) as first_date, max(date) as last_date, count(*) as n,
    max(charge_energy_added) as c_added,
    max(charger_power) as power_max,
    mode() within group (order by charger_phases) as phases_mode,
    bool_or(fast_charger_brand = 'Tesla') as tesla,
    max(conn_charge_cable) filter (where conn_charge_cable <> '<invalid>') as cable,
    max(charger_actual_current) as current_max,
    max(charger_pilot_current) as pilot_max,
    avg(charger_voltage) filter (where charger_power > 0 and charger_voltage > 5) as volt_avg,
    convert_celsius(avg(outside_temp), '$temp_unit') as temp_avg,
    (array_agg(battery_level order by date))[1] as first_soc,
    (array_agg(battery_level order by date desc))[1] as last_soc,
    convert_km((array_agg(\${preferred_range}_battery_range_km order by date))[1]::numeric, '$length_unit') as first_range,
    convert_km((array_agg(\${preferred_range}_battery_range_km order by date desc))[1]::numeric, '$length_unit') as last_range,
    bool_or(coalesce(battery_heater_on, false) or coalesce(battery_heater, false)) as heater
  from charges where charging_process_id = ${id}
),
ph as (
  select case when p is not null and p > 0 and n > 15 then case
           when r = round(p) then r
           when r = 3 and abs(p / sqrt(r) - 1) <= 0.1 then sqrt(r)
           when round(p) > 0 and abs(round(p) - p) <= 0.3 then round(p)
           else null end
         else null end as phases
  from (
    select avg(charger_power * 1000.0 / nullif(charger_actual_current::int * charger_voltage, 0)) as p,
           avg(charger_phases) as r, count(*) as n
    from charges where charging_process_id = ${id}
  ) x
),
pw as (
  select avg(case when charger_phases >= 1
                  then coalesce(ph.phases * charger_actual_current * charger_voltage / 1000.0, charger_power)
                  else charger_power end) as power_avg
  from charges cross join ph where charging_process_id = ${id}
)
select
  cp.id, cp.start_date, cp.end_date, cp.end_date is null as incomplete, cp.duration_min,
  ${placeSql("g", "a")} as place,
  ${placeFullSql("g", "a")} as place_full,
  nullif(concat_ws(', ', a.name, nullif(concat(a.road, a.house_number), ''), a.county, a.city), '') as address,
  cp.geofence_id, p.latitude, p.longitude,
  convert_km(p.odometer::numeric, '$length_unit') as odometer,
  coalesce(cp.charge_energy_added, c.c_added) as energy_added,
  cp.charge_energy_used as energy_used,
  case when cp.charge_energy_used is null then null
       else least(cp.charge_energy_added / nullif(cp.charge_energy_used, 0), 1.0) * 100 end as efficiency,
  cp.cost,
  cp.cost / nullif(greatest(cp.charge_energy_added, cp.charge_energy_used), 0) as cost_per_kwh,
  extract(epoch from c.last_date - c.first_date) as duration_s,
  c.first_date, c.last_date, c.n,
  coalesce(cp.start_battery_level, c.first_soc) as start_soc,
  coalesce(cp.end_battery_level, c.last_soc) as end_soc,
  coalesce(convert_km(cp.start_\${preferred_range}_range_km, '$length_unit'), c.first_range) as start_range,
  coalesce(convert_km(cp.end_\${preferred_range}_range_km, '$length_unit'), c.last_range) as end_range,
  c.temp_avg, c.power_max, pw.power_avg, ph.phases,
  case when nullif(c.phases_mode, 0) is null then 'DC' else 'AC' end as charge_type,
  coalesce(c.tesla, false) as supercharger,
  c.cable, c.current_max, c.pilot_max, c.volt_avg, coalesce(c.heater, false) as heater,
  prv.id as prev_id, prv.start_date as prev_date, prv.place as prev_place, prv.energy as prev_energy,
  nxt.id as next_id, nxt.start_date as next_date, nxt.place as next_place, nxt.energy as next_energy
from charging_processes cp
cross join c cross join ph cross join pw
left join positions p on p.id = cp.position_id
left join addresses a on a.id = cp.address_id
left join geofences g on g.id = cp.geofence_id
left join lateral (${neighbourSql("<", "desc")}) prv on true
left join lateral (${neighbourSql(">", "asc")}) nxt on true
where cp.id = ${id} and cp.car_id = $car_id`;
}

// 上一次 / 下一次：和充电列表一样，跳过没结束的和充进 0 kWh 的
function neighbourSql(op, dir) {
  return `select x.id, x.start_date, x.charge_energy_added as energy, ${placeSql("xg", "xa")} as place
    from charging_processes x
    left join addresses xa on xa.id = x.address_id
    left join geofences xg on xg.id = x.geofence_id
    where x.car_id = cp.car_id and x.start_date ${op} cp.start_date and x.end_date is not null
      and (x.charge_energy_added is null or x.charge_energy_added > 0)
    order by x.start_date ${dir} limit 1`;
}

function seriesSql(id) {
  return `select date, battery_level, usable_battery_level, charger_power,
  coalesce(battery_heater_on, false) or coalesce(battery_heater, false) as heater,
  convert_km(\${preferred_range}_battery_range_km::numeric, '$length_unit') as range,
  charger_voltage, charger_actual_current, charger_pilot_current,
  convert_celsius(outside_temp, '$temp_unit') as outside_temp
from charges where charging_process_id = ${id}
order by date`;
}

const PHASES = { 1: "单相", 2: "两相", 3: "三相" };

function phasesText(r) {
  const n = r.phases != null ? Math.round(r.phases * 100) / 100 : null;
  if (n == null) return null;
  return PHASES[n] || `${fmt.num(n, n % 1 ? 2 : 0)} 相`;
}

// 「9月21日 周日 23:06–次日 02:52」；没结束的写「… 23:09 开始」
function whenText(start, end) {
  return end == null ? `${fmt.day(start)} ${fmt.time(start)} 开始` : `${fmt.day(start)} ${spanText(start, end)}`;
}

function geofenceLink(r) {
  if (r.geofence_id != null) return { href: `/geo-fences/${+r.geofence_id}/edit`, label: "编辑收藏点" };
  if (Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
    return { href: `/geo-fences/new?lat=${+r.latitude}&lng=${+r.longitude}`, label: "设为收藏点" };
  }
  return null;
}

// 标题下面那行地址：地名、路名门牌、区县、城市，开头和标题重复的去掉。
// 在收藏点（「家」）充的电也写出实际地址，Grafana 在这种地方只显示收藏点名字
function addressLine(address, place) {
  if (!address) return null;
  const rest = address.startsWith(`${place}, `) ? address.slice(place.length + 2) : address;
  return rest && rest !== place ? rest : null;
}

function heroHtml(r) {
  const kind = chargeKind(r);
  const cable = r.cable ? CABLES[r.cable] || r.cable : null;
  const ph = r.charge_type === "AC" ? phasesText(r) : null;
  const gf = geofenceLink(r);
  const place = r.place || UNKNOWN_PLACE;
  const full = addressLine(r.address, place);
  return ui.card(
    html`${Number.isFinite(r.latitude) ? ui.mapBox("pg-charge-map", { height: 200 }) : ""}
      <div class="pg-charge-hero-body">
        <div class="pg-charge-hero-head">
          <span class="pg-charge-badge is-${kind.tone}">${ui.icon(kind.icon)}</span>
          <div class="pg-charge-hero-text">
            <h2 class="pg-charge-place">${place}</h2>
            ${full ? html`<p class="pg-charge-addr">${full}</p>` : ""}
          </div>
        </div>
        <p class="pg-charge-when tm-num">${whenText(r.start_date, r.end_date)}</p>
        <div class="tm-flex pg-charge-tags">
          ${ui.pill(r.charge_type === "AC" ? "交流慢充" : r.supercharger ? "特斯拉超充" : "直流快充", kind.tone)}
          ${cable ? ui.pill(cable) : ""}
          ${ph ? ui.pill(r.current_max ? `${ph} ${r.current_max} A` : ph) : ""}
          ${r.heater ? ui.pill("电池加热", "red", { icon: "snowflake" }) : ""}
        </div>
        <div class="tm-flex pg-charge-actions">
          ${ui.button(r.cost == null ? "填写费用" : "修改费用", { href: `/charge-cost/${+r.id}`, kind: "soft", small: true, icon: "cash-multiple" })}
          ${gf ? ui.button(gf.label, { href: gf.href, kind: "text", small: true, icon: "map-marker-radius" }) : ""}
        </div>
      </div>`,
    { pad: false, cls: "pg-charge-hero" }
  );
}

function statsHtml(r) {
  const dur = r.duration_s != null ? r.duration_s / 60 : r.duration_min;
  const socDelta = r.start_soc != null && r.end_soc != null ? r.end_soc - r.start_soc : null;
  const rangeDelta = r.start_range != null && r.end_range != null ? r.end_range - r.start_range : null;
  const loss = r.energy_used != null && r.energy_added != null ? Math.max(0, r.energy_used - r.energy_added) : null;
  return ui.stats(
    [
      { label: "充入电量", value: fmt.num(r.energy_added, 2), unit: "kWh", sub: r.energy_used != null ? `从电网取 ${fmt.kwh(r.energy_used, 1)}` : "用电量没有记录" },
      { label: "充电效率", value: r.efficiency != null ? fmt.num(r.efficiency, 0) : null, unit: "%", sub: loss != null ? `损耗 ${fmt.kwh(loss, 2)}` : null },
      {
        label: "费用",
        value: r.cost != null ? fmt.money(r.cost) : null,
        sub: r.cost != null ? (r.cost_per_kwh != null ? `${fmt.money(r.cost_per_kwh)}/度` : null) : "未计费，点这里填写",
        href: `/charge-cost/${+r.id}`
      },
      { label: "时长", value: fmt.duration(dur), sub: r.end_date != null ? `${fmt.time(r.first_date ?? r.start_date)}–${fmt.time(r.last_date ?? r.end_date)}` : "算到最后一条记录" },
      {
        label: "电量",
        value: r.start_soc != null ? `${r.start_soc} → ${r.end_soc}` : null,
        unit: "%",
        sub: socDelta != null ? `充了 ${socDelta}%` : null
      },
      {
        label: "续航增加",
        value: rangeDelta != null ? (rangeDelta >= 0 ? "+" : "") + fmt.num(rangeDelta, 0) : null,
        unit: fmt.unit.len,
        sub: r.start_range != null ? `${fmt.num(r.start_range, 0)} → ${fmt.len(r.end_range, 0)}` : null
      },
      { label: "平均功率", value: fmt.num(r.power_avg, 1), unit: "kW", sub: r.power_max != null ? `最高 ${fmt.kw(r.power_max)}` : null },
      { label: "车外温度", value: r.temp_avg != null ? fmt.num(r.temp_avg, 1) : null, unit: fmt.unit.temp, sub: "充电时的平均值" }
    ],
    { cols: 2 }
  );
}

// 和行程详情的上一次 / 下一次一个样子：小字「‹ 上一次」、地点（最多两行，超充站的名字长，能区分的部分在最后）、日期和充入电量
function navHtml(r, ctx) {
  const cell = (id, ms, place, energy, dir) => {
    const label = dir < 0 ? "上一次" : "下一次";
    if (id == null) {
      return html`<div class="pg-charge-nav-cell is-empty"><span class="pg-charge-nav-label">${label}</span><span class="tm-muted">${dir < 0 ? "没有更早的充电" : "这是最近的一次"}</span></div>`;
    }
    return html`<a class="pg-charge-nav-cell${dir > 0 ? " is-next" : ""}" href="${ctx.href(`/stats/charges/${id}`)}" rel="${dir < 0 ? "prev" : "next"}">
      <span class="pg-charge-nav-label">${dir < 0 ? ui.icon("chevron-left") : ""}${label}${dir > 0 ? ui.icon("chevron-right") : ""}</span>
      <span class="pg-charge-nav-title">${place || UNKNOWN_PLACE}</span>
      <span class="pg-charge-nav-sub tm-num">${fmt.dateAuto(ms)}${energy != null ? ` · ${fmt.kwh(energy, 1).replace(" ", "\u00a0")}` : ""}</span>
    </a>`;
  };
  return html`<nav class="pg-charge-nav" aria-label="上一次和下一次充电">
    ${cell(r.prev_id, r.prev_date, r.prev_place, r.prev_energy, -1)}${cell(r.next_id, r.next_date, r.next_place, r.next_energy, 1)}
  </nav>`;
}

// 连续开着电池加热的时间段 → markArea。画到关掉加热的那一条（和 Grafana 的阶梯线一样），
// 只有一条记录开着加热时也看得到
function heaterAreas(rows) {
  const out = [];
  let from = null;
  rows.forEach((s, i) => {
    if (s.heater && from == null) from = s.date;
    if (from != null && (!s.heater || i === rows.length - 1)) {
      out.push([{ xAxis: from }, { xAxis: s.date }]);
      from = null;
    }
  });
  return out.filter(([a, b]) => b.xAxis > a.xAxis);
}

// 每个电量百分比上的平均功率（面板「Charging curve」的 B：按 battery_level 分组取平均）
function curveAvg(rows) {
  const m = new Map();
  for (const s of rows) {
    if (!(s.charger_power > 0) || s.battery_level == null) continue;
    const e = m.get(s.battery_level) || { sum: 0, n: 0 };
    e.sum += s.charger_power;
    e.n++;
    m.set(s.battery_level, e);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([lvl, e]) => [lvl, e.sum / e.n]);
}

export async function render(ctx) {
  const id = api.int(ctx.params.id, { min: 1, max: 2147483647 });
  ctx.root.classList.add("pg-charge");
  ui.render(ctx.root, ui.skeleton(["map", "stats", "chart", "chart"]));

  const d = await api.batch(
    {
      cp: detailSql(id),
      series: seriesSql(id),
      // 链接里的充电不是当前这辆车的：查出是哪辆，给个切换的按钮
      owner: `select car_id from charging_processes where id = ${id}`
    },
    { signal: ctx.signal }
  );

  const r = d.cp[0];
  if (!r) {
    const owner = d.owner[0] && ctx.cars.find((c) => c.id === d.owner[0].car_id);
    ui.render(
      ctx.root,
      ui.card(
        owner
          ? ui.empty(`这次充电属于「${owner.label || owner.name}」。`, {
              icon: "car-multiple",
              title: "不是这辆车的充电",
              action: ui.button(`切换到${owner.label || owner.name}`, { kind: "soft", href: ctx.href(`/stats/charges/${id}`, { car: owner.id }) })
            })
          : ui.empty("这条充电记录不存在，可能已经被删除了。", {
              icon: "ev-station",
              title: "没有这次充电",
              action: ui.button("回到充电列表", { kind: "soft", href: ctx.href("/stats/charges") })
            })
      )
    );
    return;
  }

  ctx.setTitle(`${fmt.dateAuto(r.start_date)}的充电`);
  // Grafana 的充电详情按时间范围画图：带上这次充电的起止，不然打开是空的
  ctx.setGrafanaVars({ from: Math.floor(r.start_date), to: Math.ceil(r.end_date ?? r.last_date ?? r.start_date + 3600e3) });

  const rows = d.series;
  const isAC = r.charge_type === "AC";
  const hasVI = isAC && rows.some((s) => s.charger_voltage > 5 || s.charger_actual_current > 0);
  const pts = rows.filter((s) => s.charger_power > 0 && s.battery_level != null).map((s) => [s.battery_level, s.charger_power]);
  const ph = phasesText(r);

  // 交流时电压电流图和充电曲线在桌面上并排；直流没有电压电流图，充电曲线就占满一行
  const viSection =
    hasVI &&
    ui.section("电压和电流", ui.card(ui.chartBox("pg-charge-vi", { height: 240, heightMobile: 220, label: "充电电压和电流" })), {
      sub: [ph, r.volt_avg != null ? `平均 ${fmt.num(r.volt_avg, 0)} V` : null, r.pilot_max ? `桩最大 ${r.pilot_max} A` : null].filter(Boolean).join(" · ")
    });
  const curveSection =
    pts.length > 0 &&
    ui.section("充电曲线", ui.card(ui.chartBox("pg-charge-curve", { height: hasVI ? 240 : 280, heightMobile: 220, label: "充电功率和电量的关系" })), {
      sub: isAC ? "每个点是一条记录，线是每个电量上的平均功率" : "直流快充：电量越高，功率越低"
    });

  ui.render(
    ctx.root,
    html`
      ${r.incomplete
        ? ui.card(
            html`<div class="pg-charge-warn">
              ${ui.icon("alert-circle-outline")}
              <p>这次充电没有正常结束（TeslaMate 当时可能停止了运行），下面的数字只算到最后一条记录，不计入充电列表的统计。
                可以按<a href="https://docs.teslamate.org/docs/maintenance/manually_fixing_data" target="_blank" rel="noopener">官方文档</a>手动修复。</p>
            </div>`,
            { cls: "pg-charge-warn-card" }
          )
        : ""}
      <div class="tm-grid-2 pg-charge-top">
        ${heroHtml(r)}
        ${statsHtml(r)}
      </div>
      ${rows.length
        ? html`
            ${ui.section(
              "功率和电量",
              ui.card(ui.chartBox("pg-charge-power", { height: 280, heightMobile: 240, label: "充电功率和电量随时间的变化" })),
              { sub: r.heater ? "浅红色的时间段开着电池加热" : null }
            )}
            ${hasVI ? html`<div class="tm-grid-2">${viSection}${curveSection}</div>` : curveSection}`
        : ui.card(ui.empty("这次充电没有逐条记录，画不出曲线。", { icon: "chart-line" }))}
      ${!isAC && rows.length ? html`<p class="tm-note pg-charge-note">直流快充时车辆不上报电压和电流，所以没有电压电流图。</p>` : ""}
      ${navHtml(r, ctx)}
    `
  );

  // ---- 地图：插枪的位置
  const drawMap = async () => {
    if (!Number.isFinite(r.latitude)) return;
    const el = ctx.root.querySelector("#pg-charge-map");
    const m = await map.create(el, { center: [r.latitude, r.longitude], zoom: 15 });
    if (!m) return;
    map.marker(m, [r.latitude, r.longitude], { kind: "charge", title: r.place_full || r.place || UNKNOWN_PLACE, popup: r.place_full || r.place || UNKNOWN_PLACE });
  };

  if (!rows.length) {
    await drawMap();
    return;
  }

  // ---- 图表
  const powerColor = isAC ? "c4" : "c2";
  const tipRows = (s) => [
    { color: chart.color(powerColor), name: "功率", value: fmt.kw(s.charger_power) },
    { color: chart.color("c1"), name: "电量", value: fmt.pct(s.battery_level) },
    s.usable_battery_level != null && s.usable_battery_level !== s.battery_level ? { name: "可用电量", value: fmt.pct(s.usable_battery_level) } : null,
    s.range != null ? { name: "续航", value: fmt.len(s.range) } : null,
    s.outside_temp != null ? { name: "车外", value: fmt.temp(s.outside_temp) } : null,
    s.heater ? { color: chart.color("red"), name: "电池加热", value: "开" } : null
  ];
  const areas = heaterAreas(rows);
  const powerSeries = chart.line("功率", rows.map((s) => [s.date, s.charger_power]), { color: powerColor, area: true });
  if (areas.length) {
    powerSeries.markArea = { silent: true, itemStyle: { color: "@red/0.09" }, data: areas };
  }

  const curve = curveAvg(rows);
  // 横轴只画充过的那一段电量，刻度取整（5 / 10 / 20 一格），别出现 32.5 这种刻度
  const socLo = Math.min(...pts.map((p) => p[0]), r.start_soc ?? 100);
  const socHi = Math.max(...pts.map((p) => p[0]), r.end_soc ?? 0);
  const socStep = socHi - socLo <= 25 ? 5 : socHi - socLo <= 50 ? 10 : 20;
  const socMin = Math.max(0, Math.floor(socLo / socStep) * socStep);
  const socMax = Math.min(100, Math.max(socMin + socStep, Math.ceil(socHi / socStep) * socStep));

  // 电压轴上下各留 10 V：220 V 上下几伏的波动本来就正常，轴收得太紧看起来像在剧烈抖动
  const volts = rows.map((s) => s.charger_voltage).filter((v) => v > 5);
  const vMin = volts.length ? Math.floor((Math.min(...volts) - 10) / 10) * 10 : undefined;
  const vMax = volts.length ? Math.ceil((Math.max(...volts) + 10) / 10) * 10 : undefined;

  const jobs = [
    drawMap(),
    chart.create(ctx.root.querySelector("#pg-charge-power"), {
      xAxis: chart.timeAxis(),
      yAxis: [
        chart.valueAxis({ unit: "kW", min: 0 }),
        chart.valueAxis({ unit: "%", min: 0, max: 100, position: "right", splitLine: { show: false } })
      ],
      series: [powerSeries, chart.line("电量", rows.map((s) => [s.date, s.battery_level]), { color: "c1", yAxisIndex: 1 })],
      tooltip: chart.tooltip((ps) => {
        const s = rows[ps[0].dataIndex];
        return s ? chart.tipHtml(fmt.dateTime(s.date), tipRows(s)) : "";
      })
    })
  ];

  if (pts.length) {
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-charge-curve"), {
        xAxis: chart.valueAxis({ unit: "%", min: socMin, max: socMax, interval: socStep, splitLine: { show: false } }),
        yAxis: chart.valueAxis({ unit: "kW", min: 0 }),
        series: [
          { type: "scatter", name: "每条记录", data: pts, symbolSize: 5, itemStyle: { color: `@${powerColor}/0.45`, borderWidth: 0 } },
          chart.line("平均功率", curve, { color: "c1", smooth: true })
        ],
        // 图例藏起来了，核心还是按两条系列给图例留了顶上的位置：收回来
        legend: { show: false },
        grid: { top: 12 },
        tooltip: chart.tooltip((ps) => {
          const list = Array.isArray(ps) ? ps : [ps];
          const p = list.find((x) => x.seriesName === "平均功率") || list[0];
          if (!p) return "";
          return chart.tipHtml(`电量 ${fmt.pct(p.value[0])}`, [{ color: chart.color("c1"), name: p.seriesName === "平均功率" ? "平均功率" : "功率", value: fmt.kw(p.value[1], 1) }]);
        })
      })
    );
  }

  if (hasVI) {
    jobs.push(
      chart.create(ctx.root.querySelector("#pg-charge-vi"), {
        xAxis: chart.timeAxis(),
        yAxis: [
          chart.valueAxis({ unit: "V", min: vMin, max: vMax, interval: vMax - vMin > 60 ? 20 : 10 }),
          chart.valueAxis({ unit: "A", min: 0, position: "right", splitLine: { show: false } })
        ],
        series: [
          // 拔枪那一条电压是 0：画成断开，免得纵轴被拉到 0、电压的起伏看不出来
          chart.line("电压", rows.map((s) => [s.date, s.charger_voltage > 5 ? s.charger_voltage : null]), { color: "c3", fmt: (v) => `${fmt.num(v)} V` }),
          chart.line("电流", rows.map((s) => [s.date, s.charger_actual_current]), { color: "c5", yAxisIndex: 1, fmt: (v) => `${fmt.num(v)} A` }),
          chart.line("桩允许", rows.map((s) => [s.date, s.charger_pilot_current]), { color: "text-3", yAxisIndex: 1, dashed: true, width: 1.5, fmt: (v) => `${fmt.num(v)} A` })
        ]
      })
    );
  }
  await Promise.all(jobs);
}
