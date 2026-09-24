// 统计首页（/stats/）：这辆车的概况（对应 Grafana Overview 的一部分）、本月数字、最近的行程 / 充电、电池健康，
// 再往下是各统计页的入口（分组来自 registry）和 Grafana 原版面板。
//
// 数字的口径：
//   概况：电量、续航、里程表、软件版本和 Overview 面板的 Battery Level / Range / Odometer / Firmware 一样取最近一条记录；
//   本月：里程、平均能耗（净）和 Overview 的 Total Distance logged / Ø Consumption (net) 同一算法，
//         行程、充电和行程页、充电页的列表一样只算已经结束的（充电再去掉充进 0 kWh 的）；
//   电池：估算衰减、满电续航照 Battery Health 面板的 aux 变量（custom_kwh_new / custom_max_range 取默认 0）。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import { entries, GRAFANA_DASHBOARDS } from "./registry.js";
import { DRIVE_ITEM_SQL, driveItem } from "./_drive-item.js";
import { CHARGE_ITEM_SQL, chargeItem } from "./_charge-item.js";

export const title = "统计";
export const range = null;
export const css = true;

// ---------------------------------------------------------------- SQL

// 概况：里程表、软件版本各取最近一条；电量和续航取最近的位置点或充电记录里更晚的那条（和 Overview 一样，
// 位置点只看有续航读数的，streaming 推送点没有）
const CAR_SQL = `select
  (select convert_km(odometer::numeric, '$length_unit') from positions
    where car_id = $car_id and ideal_battery_range_km is not null order by date desc limit 1) as odometer,
  (select split_part(version, ' ', 1) from updates where car_id = $car_id order by start_date desc limit 1) as version,
  (select start_date from updates where car_id = $car_id order by start_date desc limit 1) as version_date,
  l.battery_level, l.usable_battery_level, l.range, l.date
from (select null) as base
left join lateral (
  select * from (
    (select battery_level, usable_battery_level, convert_km(\${preferred_range}_battery_range_km, '$length_unit') as range, date
     from positions
     where car_id = $car_id and ideal_battery_range_km is not null
     order by date desc limit 1)
    union all
    (select c.battery_level, c.usable_battery_level, convert_km(c.\${preferred_range}_battery_range_km, '$length_unit'), c.date
     from charges c join charging_processes p on p.id = c.charging_process_id
     where p.car_id = $car_id
     order by c.date desc limit 1)
  ) as x
  order by date desc
  limit 1
) as l on true`;

// 本月和上月同期：两段时间各一行（k = cur / prev）。f、t 是毫秒，在 JS 里算好（整数，直接拼进 SQL）
function monthSql(w) {
  const ts = (ms) => `timezone('UTC', to_timestamp(${Math.round(ms)} / 1000.0))`;
  return `with p(k, f, t) as (values
  ('cur', ${ts(w.cur[0])}, ${ts(w.cur[1])}),
  ('prev', ${ts(w.prev[0])}, ${ts(w.prev[1])})
)
select p.k, dr.drives, dr.distance, dr.energy, ch.charges, ch.added, ch.cost
from p
left join lateral (
  select count(*) as drives,
         convert_km(sum(d.distance)::numeric, '$length_unit') as distance,
         sum((d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency) as energy
  from drives d
  join cars c on c.id = d.car_id
  where d.car_id = $car_id and d.end_date is not null and d.start_date >= p.f and d.start_date < p.t
) as dr on true
left join lateral (
  select count(*) as charges, sum(cp.charge_energy_added) as added, sum(cp.cost) as cost
  from charging_processes cp
  where cp.car_id = $car_id and cp.end_date is not null and cp.charge_energy_added > 0
    and cp.start_date >= p.f and cp.start_date < p.t
) as ch on true`;
}

// 电池健康：Battery Health 面板 aux 变量里的这几项（算法照抄，只留首页要用的）。
//   容量：按充电记录的「额定续航 × 推算能效 ÷ 可用电量」推算；现在 = 最近 100 条的平均，新车 = 每次充电最后一条里的最大值
//   满电续航：现在 = 最近一条记录的续航 ÷ 可用电量；新车 = 按天汇总里最大的
const BATTERY_SQL = `with aux as (
  select car_id, coalesce(derived_efficiency, car_efficiency) as efficiency
  from (
    select
      round((charge_energy_added / nullif(end_rated_range_km - start_rated_range_km, 0))::numeric, 3) * 100 as derived_efficiency,
      count(*) as count,
      cars.id as car_id,
      cars.efficiency * 100 as car_efficiency
    from cars
      left join charging_processes on
        cars.id = charging_processes.car_id
        and duration_min > 10
        and end_battery_level <= 95
        and start_rated_range_km is not null
        and end_rated_range_km is not null
        and charge_energy_added > 0
    where cars.id = $car_id
    group by 1, 3, 4
    order by 2 desc
    limit 1
  ) as e
),
cur_cap as (
  select avg(capacity) as capacity
  from (
    select c.rated_battery_range_km * aux.efficiency / c.usable_battery_level as capacity
    from charging_processes cp
      inner join charges c on c.charging_process_id = cp.id
      inner join aux on cp.car_id = aux.car_id
    where cp.car_id = $car_id
      and cp.end_date is not null
      and cp.charge_energy_added >= aux.efficiency
      and c.usable_battery_level > 0
    order by cp.end_date desc, c.date desc
    limit 100
  ) as last_charges
),
max_cap as (
  select max(c.rated_battery_range_km * aux.efficiency / c.usable_battery_level) as capacity
  from charging_processes cp
    inner join (
      select charging_process_id, max(date) as date from charges where usable_battery_level > 0 group by charging_process_id
    ) as g on cp.id = g.charging_process_id
    inner join charges c on c.charging_process_id = cp.id and c.date = g.date
    inner join aux on cp.car_id = aux.car_id
  where cp.car_id = $car_id
    and cp.end_date is not null
    and cp.charge_energy_added >= aux.efficiency
),
cur_range as (
  select range * 100.0 / usable_battery_level as range
  from (
    (select date, \${preferred_range}_battery_range_km as range, usable_battery_level
     from positions
     where car_id = $car_id and ideal_battery_range_km is not null and usable_battery_level > 0
     order by date desc limit 1)
    union all
    (select c.date, c.\${preferred_range}_battery_range_km as range, c.usable_battery_level
     from charges c inner join charging_processes p on p.id = c.charging_process_id
     where p.car_id = $car_id and c.usable_battery_level > 0
     order by c.date desc limit 1)
  ) as data
  order by date desc
  limit 1
),
max_range as (
  select
    case when sum(usable_battery_level) = 0 then sum(\${preferred_range}_battery_range_km) * 100
         else sum(\${preferred_range}_battery_range_km) / sum(usable_battery_level) * 100 end as range
  from (
    select c.usable_battery_level, c.date, c.\${preferred_range}_battery_range_km
    from charges c inner join charging_processes p on p.id = c.charging_process_id
    where p.car_id = $car_id and c.usable_battery_level is not null
  ) as data
  group by floor(extract(epoch from date) / 86400)
  order by 1 desc
  limit 1
)
select
  convert_km(max_range.range, '$length_unit') as max_range,
  convert_km(cur_range.range, '$length_unit') as current_range,
  max_cap.capacity::float as max_capacity,
  cur_cap.capacity::float as current_capacity
from (select null) as base
  left join max_range on true
  left join cur_range on true
  left join max_cap on true
  left join cur_cap on true`;

// ---------------------------------------------------------------- 本月 / 上月同期

// 本月 1 日 0 点到现在；上月同期是上月 1 日到上月的同一天同一时刻（这个月比上月长时截到上月月底）。
// 「现在」取到下一个整分钟，一分钟内回到首页能命中查询缓存
function monthWindows() {
  const now = new Date(Math.ceil(Date.now() / 60e3) * 60e3);
  const curFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const prevTo =
    now.getDate() > prevDays
      ? curFrom
      : new Date(prevFrom.getFullYear(), prevFrom.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  return { cur: [curFrom.getTime(), now.getTime()], prev: [prevFrom.getTime(), prevTo.getTime()] };
}

function monthNumbers(row) {
  const r = row || {};
  const distance = +r.distance || 0;
  return {
    drives: +r.drives || 0,
    distance,
    energy: r.energy == null ? null : +r.energy,
    cons: distance > 0 && r.energy != null ? (r.energy * 1000) / distance : null,
    charges: +r.charges || 0,
    added: +r.added || 0,
    cost: r.cost == null ? null : +r.cost
  };
}

// 「比上月同期 ↑12%」。lowerIsBetter：能耗这种越低越好的，降了是绿色、涨了是橙色；其余只标方向不评价
function delta(cur, prev, { lowerIsBetter = false } = {}) {
  const c = cur == null ? 0 : cur;
  if (prev == null || !(prev > 0)) return c > 0 ? "上月同期没有记录" : "上月同期也没有";
  if (cur == null) return "本月还没有";
  const r = (c - prev) / prev;
  const pct = Math.round(Math.abs(r) * 100);
  if (pct === 0) return "和上月同期持平";
  const up = r > 0;
  const tone = lowerIsBetter ? (up ? "is-worse" : "is-better") : "";
  return html`比上月同期 <span class="pg-home-delta ${tone}">${up ? "↑" : "↓"}${pct > 999 ? "999+" : pct}%</span>`;
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const car = ctx.car;
  // 首页在没有车辆数据时也能打开（registry 里 noCar）：只列入口和 Grafana 面板
  if (!car) {
    ui.render(
      ctx.root,
      html`${ui.card(ui.empty("TeslaMate 记录到车辆数据后，这里会显示本月里程、最近的行程和充电。", { icon: "car-side", title: "还没有车辆数据" }))}
        ${entriesHtml(ctx)}${grafanaHtml(ctx)}`
    );
    return;
  }

  // 入口和 Grafana 列表不依赖数据，先画出来；数据块取不到时只在这一块里报错，下面的入口照样能用
  ui.render(ctx.root, html`<div class="pg-home-slot" id="pg-home-data"></div>${entriesHtml(ctx)}${grafanaHtml(ctx)}`);
  await loadData(ctx, ctx.root.querySelector("#pg-home-data"));
}

async function loadData(ctx, slot) {
  ui.render(slot, ui.skeleton(["kv", "stats", "list"], { rows: 3 }));
  const w = monthWindows();
  let d;
  try {
    d = await api.batch(
      {
        car: CAR_SQL,
        month: monthSql(w),
        battery: BATTERY_SQL,
        drives: DRIVE_ITEM_SQL("true", { limit: 3 }),
        charges: CHARGE_ITEM_SQL("true", { limit: 3 })
      },
      { signal: ctx.signal }
    );
  } catch (e) {
    if (e.name === "AbortError") throw e;
    // 和路由一样：登录过期、断网是预料之中的，不算程序错误
    if (!e.auth && !e.network) console.error(e);
    ui.render(slot, ui.card(ui.error(e, () => loadData(ctx, slot).catch(() => {}))));
    return;
  }

  const cur = monthNumbers(d.month.find((r) => r.k === "cur"));
  const prev = monthNumbers(d.month.find((r) => r.k === "prev"));
  // 上月同期什么都没有（比如车是这个月才接入的）：在标题下说一次，别让六格都写「上月同期没有记录」
  const prevEmpty = !prev.drives && !prev.charges;
  const prevText = fmt.dateRange(w.prev[0], w.prev[1] - 1);

  ui.render(
    slot,
    html`<div class="pg-home-data">
      <div class="pg-home-top">
        ${heroHtml(ctx.car, d.car[0] || {}, ctx)}
        ${batteryHtml(d.battery[0] || {}, ctx)}
      </div>
      ${ui.section("本月", monthStats(cur, prevEmpty ? null : prev), {
        action: { href: ctx.href("/stats/summary"), label: "按月汇总" },
        // 后半句整体不断开：320 宽下原来会剩一个「比」单独占一行
        sub: prevEmpty
          ? html`${fmt.date(w.cur[0])} – 今天；<span class="pg-home-nobr">上月同期（${prevText}）没有记录</span>`
          : html`${fmt.date(w.cur[0])} – 今天，<span class="pg-home-nobr">对比上月同期 ${prevText}</span>`
      })}
      <div class="tm-grid-2">
        ${ui.section(
          "最近行程",
          d.drives.length
            ? ui.card(ui.list(d.drives.map((r) => driveItem(r, ctx))), { pad: false })
            : ui.card(ui.empty("还没有记录到行程。", { icon: "road-variant" })),
          { action: { href: ctx.href("/stats/drives"), label: "全部" } }
        )}
        ${ui.section(
          "最近充电",
          d.charges.length
            ? ui.card(ui.list(d.charges.map((r) => chargeItem(r, ctx))), { pad: false })
            : ui.card(ui.empty("还没有记录到充电。", { icon: "ev-station" })),
          { action: { href: ctx.href("/stats/charges"), label: "全部" } }
        )}
      </div>
    </div>`
  );
}

// ---------------------------------------------------------------- 概况卡片

function modelText(car) {
  const parts = [];
  if (car.model) parts.push(`Model ${car.model}`);
  if (car.marketingName) parts.push(car.marketingName);
  else if (car.trim) parts.push(car.trim);
  return parts.join(" · ");
}

function fact(icon, label, value, { sub, href, extra } = {}) {
  const body = html`<span class="pg-home-fact-label">${ui.icon(icon)}${label}</span>
    <span class="pg-home-fact-value tm-num">${value}</span>
    ${extra || ""}
    ${sub ? html`<span class="pg-home-fact-sub">${sub}</span>` : ""}`;
  return href ? html`<a class="pg-home-fact" href="${href}">${body}</a>` : html`<div class="pg-home-fact">${body}</div>`;
}

function heroHtml(car, info, ctx) {
  const level = info.battery_level;
  // 冷车时可用电量比显示电量低（续航打折），和 TeslaMate 主页一样标出来
  const usableNote = level != null && info.usable_battery_level != null && info.usable_battery_level < level ? `可用 ${info.usable_battery_level}%` : null;
  const levelTone = level == null ? null : level < 10 ? "red" : level < 20 ? "amber" : "green";
  const model = modelText(car);
  return html`<div class="tm-card pg-home-hero">
    <div class="pg-home-car">
      <span class="pg-home-car-icon">${ui.icon("car-electric-outline")}</span>
      <div class="pg-home-car-main">
        <div class="pg-home-car-name">${car.name || car.label || "我的车"}</div>
        ${model ? html`<div class="pg-home-car-model">${model}</div>` : ""}
      </div>
      ${info.date ? html`<span class="pg-home-updated" title="${fmt.dateTime(info.date)}">${fmt.rel(info.date)}更新</span>` : ""}
    </div>
    <div class="pg-home-facts">
      ${fact("battery-50", "电量", fmt.pct(level), {
        href: ctx.href("/stats/levels"),
        extra: level != null ? ui.bar(level, 100, levelTone) : null,
        sub: usableNote
      })}
      ${fact("gauge", "续航", fmt.len(info.range), { sub: ctx.settings.preferredRange === "ideal" ? "理想续航" : "额定续航" })}
      ${fact("counter", "里程表", fmt.len(info.odometer), { href: ctx.href("/stats/levels"), sub: "总里程" })}
      ${fact("update", "软件版本", info.version || "—", {
        href: ctx.href("/stats/updates"),
        sub: info.version_date ? `${fmt.dateAuto(info.version_date)} 更新` : null
      })}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- 电池小卡

function batteryHtml(b, ctx) {
  const hasCap = b.current_capacity != null && b.max_capacity > 0;
  // 面板：GREATEST(0, 100 − 现在容量 × 100 ÷ 新车容量)
  const degr = hasCap ? Math.max(0, 100 - (b.current_capacity * 100) / b.max_capacity) : null;
  // 面板的衰减表盘：10% 以下绿、10–20% 黄、20% 以上红
  const tone = degr == null ? "" : degr < 10 ? "green" : degr < 20 ? "amber" : "red";
  const lost = b.max_range != null && b.current_range != null ? b.max_range - b.current_range : null;
  return html`<a class="tm-card pg-home-batt" href="${ctx.href("/stats/battery")}">
    <div class="pg-home-batt-head">
      <span class="pg-home-batt-title">${ui.icon("battery-heart-variant")}电池健康</span>
      ${ui.icon("chevron-right", { cls: "pg-home-chevron" })}
    </div>
    <div class="pg-home-batt-grid">
      <div class="pg-home-batt-cell">
        <span class="pg-home-fact-label">估算衰减</span>
        <span class="pg-home-batt-value tm-num${tone ? " tm-tone-" + tone : ""}">${degr == null ? "—" : fmt.pct(degr, 1)}</span>
        <span class="pg-home-fact-sub">${degr == null ? "还没有足够长的充电" : `容量 ${fmt.num(b.current_capacity, 1)} / ${fmt.num(b.max_capacity, 1)} kWh`}</span>
      </div>
      <div class="pg-home-batt-cell">
        <span class="pg-home-fact-label">满电续航</span>
        <span class="pg-home-batt-value tm-num">${fmt.len(b.current_range)}</span>
        <span class="pg-home-fact-sub">${
          b.max_range != null
            ? html`<span class="pg-home-segs"><span>新车 ${fmt.len(b.max_range)}</span>${lost >= 0.5 ? html`<span>少 ${fmt.len(lost)}</span>` : ""}</span>`
            : "—"
        }</span>
      </div>
    </div>
    ${b.max_range > 0 && b.current_range != null ? ui.bar(b.current_range, b.max_range, tone || "green") : ""}
    <span class="pg-home-batt-note">按充电时的满电续航推算，是估计值</span>
  </a>`;
}

// ---------------------------------------------------------------- 本月

// prev 为 null 时不写对比（上月同期没有任何记录，标题下已经说了）
function monthStats(cur, prev) {
  const cmp = (k, opts) => (prev ? delta(cur[k], prev[k], opts) : null);
  return ui.stats(
    [
      { label: "里程", icon: "road-variant", value: fmt.num(cur.distance, 0), unit: fmt.unit.len, sub: cmp("distance") },
      { label: "行程", icon: "map-marker-path", value: cur.drives, unit: "次", sub: cmp("drives") },
      { label: "耗电（净）", icon: "flash-outline", value: cur.energy != null ? fmt.num(cur.energy, 1) : cur.drives ? null : "0", unit: "kWh", sub: cmp("energy") },
      // 叫「能耗（净）」和行程详情、旅程一致；「平均能耗（净）」带图标在 320 宽下会被截成「平均能耗（…」
      { label: "能耗（净）", icon: "leaf", value: cur.cons, unit: fmt.unit.cons, sub: cmp("cons", { lowerIsBetter: true }) },
      // 和充电页一样用「充进电池的电量」（按月汇总页的「充电量」是从电网取的，含损耗，会大一些）
      { label: "充入电量", icon: "ev-station", value: fmt.num(cur.added, 1), unit: "kWh", sub: cmp("added") },
      { label: "充电花费", icon: "cash-multiple", value: cur.cost != null ? fmt.money(cur.cost) : cur.charges ? null : "¥0.00", sub: cmp("cost") }
    ],
    { cols: 3 }
  );
}

// ---------------------------------------------------------------- 入口、Grafana

function entriesHtml(ctx) {
  return entries().map((g) =>
    ui.section(
      g.title,
      html`<div class="tm-entries pg-home-entries">${g.items.map(
        (r) => html`<a class="tm-entry" href="${ctx.href(r.path)}">
          <span class="tm-entry-icon is-${g.tone}">${ui.icon(r.icon)}</span>
          <span class="tm-entry-main">
            <span class="tm-entry-title">${r.title}</span>
            ${r.desc ? html`<span class="tm-entry-desc">${r.desc}</span>` : ""}
          </span>
          ${ui.icon("chevron-right", { cls: "tm-row-chevron" })}
        </a>`
      )}</div>`
    )
  );
}

// 折叠起来：大多数时候用不到，展开是一串在新窗口打开的链接（带当前车辆）
function grafanaHtml(ctx) {
  return html`<details class="tm-card pg-home-grafana">
    <summary>
      <span class="tm-entry-icon is-muted">${ui.icon("view-dashboard-outline")}</span>
      <span class="tm-entry-main">
        <span class="tm-entry-title">Grafana 原版面板</span>
        <span class="tm-entry-desc">在 Grafana 里看原来的图表</span>
      </span>
      ${ui.icon("chevron-down", { cls: "pg-home-grafana-chevron" })}
    </summary>
    <div class="tm-links">${GRAFANA_DASHBOARDS.map(
      (d) => html`<a href="${ctx.grafanaLink(d.uid)}" target="_blank" rel="noopener" title="${d.en}">
        <span>${d.title}</span><small>${d.en}</small>${ui.icon("open-in-new")}
      </a>`
    )}</div>
  </details>`;
}
