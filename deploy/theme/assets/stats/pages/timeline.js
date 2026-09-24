// 时间线（对应 Grafana「Timeline」面板 SUBgwtigz）：行驶、充电、停车、数据缺失、软件更新按时间倒序排成一条流。
// 面板是一条五段 UNION 的 SQL，这里拆成五条查询一次 batch 取回，在前端合并、筛选、分组：
//   - 行驶 / 充电直接用 _drive-item.js / _charge-item.js 的 SQL 和列表行，和行程、充电页长得一样，点进去是详情；
//   - 停车、数据缺失、软件更新的 SQL 照抄面板（改动见各自的注释），行点一下展开明细（面板里的里程表、续航、收藏点链接等都在里面）。
// 事件类型、地点搜索都在前端筛：数据已经在手上，筛选不用再等服务器。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import { DRIVE_ITEM_SQL, driveItem } from "./_drive-item.js";
import { CHARGE_ITEM_SQL, chargeItem } from "./_charge-item.js";
import { placeSql, UNKNOWN_PLACE } from "./_shared.js";

export const title = "时间线";
export const range = { default: "7d" };
export const css = true;

// 一次画 50 条，「再显示」往后加：「全部」范围有两千多条，一次都画出来手机会卡
const PAGE = 50;

// MDI 的 parking、map-marker-question-outline（core/icons.js 里没有，直接传 path）
const ICON_PARK = "M13.2,11H10V7H13.2A2,2 0 0,1 15.2,9A2,2 0 0,1 13.2,11M13,3H6V21H10V15H13A6,6 0 0,0 19,9C19,5.68 16.31,3 13,3Z";
const ICON_MISSING =
  "M12,1C7.59,1 4,4.59 4,9C4,14.57 10.96,22.34 11.26,22.67L12,23.5L12.74,22.67C13.04,22.34 20,14.57 20,9C20,4.59 16.41,1 12,1M12,20.47C9.82,17.86 6,12.54 6,9A6,6 0 0,1 12,3A6,6 0 0,1 18,9C18,12.83 13.75,18.36 12,20.47M11.13,14H12.88V15.75H11.13M12,5A3.5,3.5 0 0,0 8.5,8.5H10.25A1.75,1.75 0 0,1 12,6.75A1.75,1.75 0 0,1 13.75,8.5C13.75,10.26 11.13,10.04 11.13,12.88H12.88C12.88,10.91 15.5,10.69 15.5,8.5A3.5,3.5 0 0,0 12,5Z";

// 事件类型：顺序即筛选标签的顺序；grafana 是面板 action_filter 变量里对应的值
const TYPES = [
  { key: "drive", label: "行驶", icon: "road-variant", grafana: "🚗 Driving" },
  { key: "charge", label: "充电", icon: "ev-station", grafana: "🔋 Charging" },
  { key: "park", label: "停车", icon: ICON_PARK, grafana: "🅿️ Parking" },
  { key: "missing", label: "数据缺失", icon: ICON_MISSING, grafana: "❓ Missing" },
  { key: "update", label: "软件更新", icon: "update", grafana: "💾 Updating" }
];
const TYPE_KEYS = TYPES.map((t) => t.key);
// 同一时刻开始的两条（极少见）按这个顺序排
const TYPE_RANK = { update: 0, missing: 1, charge: 2, drive: 3, park: 4 };

// 面板搜索地址用的写法（围栏名，或「地名 / 路名 门牌, 城市」）。搜索时这个和列表上显示的短地名都匹配
const FULL = (g, a) =>
  `COALESCE(${g}.name, CONCAT_WS(', ', COALESCE(${a}.name, nullif(CONCAT_WS(' ', ${a}.road, ${a}.house_number), '')), ${a}.city))`;

// ---------------------------------------------------------------- SQL

// 行驶：_drive-item.js 的 SQL 外面再包一层，补上面板搜索用的完整地址
const DRIVES_SQL = `select x.*, ${FULL("sg", "sa")} as start_full, ${FULL("eg", "ea")} as end_full
from (${DRIVE_ITEM_SQL("$__timeFilter(d.start_date)")}) x
join drives d on d.id = x.id
left join addresses sa on sa.id = d.start_address_id
left join addresses ea on ea.id = d.end_address_id
left join geofences sg on sg.id = d.start_geofence_id
left join geofences eg on eg.id = d.end_geofence_id`;

// 充电：同上。_charge-item.js 默认不含没结束的、充进 0 kWh 的充电，和面板的 charge_energy_added > 0 一致
const CHARGES_SQL = `select x.*, ${FULL("g", "a")} as place_full
from (${CHARGE_ITEM_SQL("$__timeFilter(cp.start_date)")}) x
join charging_processes cp on cp.id = x.id
left join addresses a on a.id = cp.address_id
left join geofences g on g.id = cp.geofence_id`;

// 停车：一次行驶 / 充电结束到下一次开始之间（面板的写法）。和面板不同的两处：
//   1. 窗口函数（下一次什么时候开始）算在这辆车的全部记录上，再按时间筛。面板先筛再算，
//      范围里最后一次停车就找不到「下一次」了（选过去的某个月时，月底那次停车没有结束时间）；
//   2. 充电后的停车，开始电量取充电结束时的电量。面板取的是插枪那一刻的位置点，
//      结果「充完电停一夜」显示成停车时电量涨了 18%。
// 没有结束的行驶 / 充电（TeslaMate 中途停过）不算分界，和面板一样：它们没有结束时间，否则后面那段停车就没了。
// 耗电（kWh）和面板一样：(下次出发的续航 + 期间里程表的变化 − 这次结束的续航) × 车辆能效，负数是掉电。
const PARK_SQL = `with a as (
  select d.start_date, d.end_date, d.start_position_id, d.end_position_id, d.end_address_id, d.end_geofence_id,
         d.start_\${preferred_range}_range_km as start_range, d.end_\${preferred_range}_range_km as end_range,
         ep.battery_level as end_soc, d.car_id
  from drives d
  join positions ep on ep.id = d.end_position_id
  where d.car_id = $car_id and d.end_date is not null
  union all
  select cp.start_date, cp.end_date, cp.position_id, cp.position_id, cp.address_id, cp.geofence_id,
         cp.start_\${preferred_range}_range_km, cp.end_\${preferred_range}_range_km,
         coalesce(cp.end_battery_level, p.battery_level), cp.car_id
  from charging_processes cp
  join positions p on p.id = cp.position_id
  where cp.car_id = $car_id and cp.end_date is not null
),
w as (
  select a.*, ep.odometer as end_odo, ep.latitude, ep.longitude,
         lead(a.start_date) over w as next_start,
         lead(a.start_range) over w as next_range,
         lead(sp.odometer) over w as next_odo,
         lead(sp.battery_level) over w as next_soc
  from a
  join positions sp on sp.id = a.start_position_id
  join positions ep on ep.id = a.end_position_id
  window w as (order by a.start_date)
)
select
  w.end_date as start_date, w.next_start as end_date,
  extract(epoch from w.next_start - w.end_date) / 60 as duration_min,
  ${placeSql("g", "ad")} as place, ${FULL("g", "ad")} as place_full,
  w.end_geofence_id as geofence_id, w.latitude, w.longitude,
  w.end_soc as start_soc, w.next_soc as end_soc,
  convert_km(w.end_odo::numeric, '$length_unit') as odometer,
  convert_km(w.next_range::numeric, '$length_unit') as end_range,
  ((w.next_range + (w.next_odo - w.end_odo)) - w.end_range) * c.efficiency as energy,
  convert_km(((w.next_range + (w.next_odo - w.end_odo)) - w.end_range)::numeric, '$length_unit') as range_diff
from w
join cars c on c.id = w.car_id
left join addresses ad on ad.id = w.end_address_id
left join geofences g on g.id = w.end_geofence_id
where $__timeFilter(w.end_date)
order by w.end_date desc`;

// 数据缺失：相邻两次行程（按 id）之间里程表多了 0.5 km 以上、地点也变了 —— TeslaMate 没在记录时车被开走了。
// 条件照抄面板；面板这一行不给时长和电量，这里补上。结束时的续航取恢复记录那一刻的读数
// （面板取的是下一次行程结束时的续航，和这段缺失对不上）。
const MISSING_SQL = `select
  t1.end_date + interval '1 second' as start_date, t2.start_date as end_date,
  extract(epoch from t2.start_date - t1.end_date) / 60 as duration_min,
  ${placeSql("g1", "a1")} as start_place, ${placeSql("g2", "a2")} as end_place,
  ${FULL("g1", "a1")} as start_full, ${FULL("g2", "a2")} as end_full,
  t1.end_geofence_id as start_geofence_id, t2.start_geofence_id as end_geofence_id,
  p1.latitude as start_lat, p1.longitude as start_lng, p2.latitude as end_lat, p2.longitude as end_lng,
  p1.battery_level as start_soc, p2.battery_level as end_soc,
  convert_km(p2.odometer::numeric, '$length_unit') as odometer,
  convert_km((p2.odometer - p1.odometer)::numeric, '$length_unit') as distance,
  convert_km(p1.\${preferred_range}_battery_range_km::numeric, '$length_unit') as start_range,
  convert_km(p2.\${preferred_range}_battery_range_km::numeric, '$length_unit') as end_range,
  ((p2.\${preferred_range}_battery_range_km + (p2.odometer - p1.odometer)) - p1.\${preferred_range}_battery_range_km) * c.efficiency as energy,
  convert_km(((p2.\${preferred_range}_battery_range_km + (p2.odometer - p1.odometer)) - p1.\${preferred_range}_battery_range_km)::numeric, '$length_unit') as range_diff
from drives t1
join cars c on c.id = t1.car_id
join (select d.*, lag(d.id) over (order by d.id) as previous_id from drives d where d.car_id = $car_id) t2 on t1.id = t2.previous_id
join positions p1 on p1.id = t1.end_position_id
join positions p2 on p2.id = t2.start_position_id
join addresses a1 on a1.id = t1.end_address_id
join addresses a2 on a2.id = t2.start_address_id
left join geofences g1 on g1.id = t1.end_geofence_id
left join geofences g2 on g2.id = t2.start_geofence_id
where $__timeFilter(t1.end_date)
  and p2.odometer - p1.odometer > 0.5
  and t1.end_address_id <> t2.start_address_id
  and ((coalesce(t1.end_geofence_id, 0) <> coalesce(t2.start_geofence_id, 0)) or (t1.end_geofence_id is null and t2.start_geofence_id is null))
order by t1.end_date desc`;

const UPDATES_SQL = `select id, start_date, end_date, extract(epoch from end_date - start_date) / 60 as duration_min, version
from updates
where car_id = $car_id and $__timeFilter(start_date)
order by start_date desc`;

// 正在进行的行驶 / 充电：TeslaMate 开始时就建了这一行，结束才填 end_date，所以上面的停车查询看不到它，
// 最后那段停车会一直「停车中」算到现在 —— 车其实已经开走了 / 插上枪了。
// 只认最近 15 分钟还有新记录的（行驶看位置点、充电看充电记录），很久以前中途断掉的（TeslaMate 停过，永远没有结束时间）不算。
// 位置点带上 ideal_battery_range_km is not null，好用 (car_id, date) 的索引（行驶中每十几秒就有一条完整记录）
const LIVE_SQL = `select kind, start_date from (
  select 'drive' as kind, d.start_date
  from drives d
  where d.car_id = $car_id and d.end_date is null
    and exists (select 1 from positions p
                where p.car_id = $car_id and p.ideal_battery_range_km is not null and p.drive_id = d.id
                  and p.date > (now() at time zone 'UTC') - interval '15 minutes')
  union all
  select 'charge', cp.start_date
  from charging_processes cp
  where cp.car_id = $car_id and cp.end_date is null
    and exists (select 1 from charges c
                where c.charging_process_id = cp.id and c.date > (now() at time zone 'UTC') - interval '15 minutes')
) x
order by start_date desc
limit 1`;

// ---------------------------------------------------------------- 筛选参数（URL → 校验过的值）

function readFilters(q) {
  const raw = (q.get("types") || "").split(",").filter((k) => TYPE_KEYS.includes(k));
  // 全选和不选都当「全部」，URL 里不写
  const types = raw.length && raw.length < TYPE_KEYS.length ? TYPE_KEYS.filter((k) => raw.includes(k)) : [];
  const text = (q.get("q") || "").trim().slice(0, 60);
  return { types, text };
}

// ---------------------------------------------------------------- 数据 → 事件

const lower = (...xs) => xs.filter((x) => x != null && x !== "").join("\n").toLowerCase();

function toEvents(d) {
  const out = [];
  const live = d.live[0] || null;
  for (const r of d.drives) {
    out.push({ type: "drive", start: r.start_date, end: r.end_date, row: r, hay: lower(r.start_place, r.end_place, r.start_full, r.end_full) });
  }
  for (const r of d.charges) {
    out.push({ type: "charge", start: r.start_date, end: r.end_date, row: r, hay: lower(r.place, r.place_full) });
  }
  for (let r of d.park) {
    // 最后那段停车之后车正在开 / 正在充：停车到它开始为止（行对象和缓存共用，复制一份再改）
    if (r.end_date == null && live && live.start_date > r.start_date) {
      r = { ...r, end_date: live.start_date, duration_min: (live.start_date - r.start_date) / 60e3, live: live.kind };
    }
    out.push({ type: "park", start: r.start_date, end: r.end_date, row: r, hay: lower(r.place, r.place_full) });
  }
  for (const r of d.missing) {
    out.push({ type: "missing", start: r.start_date, end: r.end_date, row: r, hay: lower(r.start_place, r.end_place, r.start_full, r.end_full) });
  }
  for (const r of d.updates) {
    out.push({ type: "update", start: r.start_date, end: r.end_date, row: r, hay: lower(r.version) });
  }
  out.sort((a, b) => b.start - a.start || TYPE_RANK[a.type] - TYPE_RANK[b.type]);
  return out;
}

function matchText(events, text) {
  if (!text) return events;
  const t = text.toLowerCase();
  return events.filter((e) => e.hay.includes(t));
}

function countByType(events) {
  const n = Object.fromEntries(TYPE_KEYS.map((k) => [k, 0]));
  for (const e of events) n[e.type]++;
  return n;
}

// 还在停着（最后一次行驶 / 充电之后没有新记录）：时长算到现在
function parkMinutes(r) {
  if (r.duration_min != null) return r.duration_min;
  return r.end_date == null ? Math.max(0, (Date.now() - r.start_date) / 60e3) : null;
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const f = readFilters(ctx.query);
  ctx.setGrafanaVars({
    // 多选时 Grafana 要重复的 var-action_filter 参数，链接工具只能带一个值，只选一类时才带
    "var-action_filter": f.types.length === 1 ? TYPES.find((t) => t.key === f.types[0]).grafana : null,
    "var-text_filter": f.text || null
  });

  ui.render(ctx.root, ui.skeleton(["stats", "list"]));

  const d = await api.batch(
    { drives: DRIVES_SQL, charges: CHARGES_SQL, park: PARK_SQL, missing: MISSING_SQL, updates: UPDATES_SQL, live: LIVE_SQL },
    { signal: ctx.signal }
  );
  const all = toEvents(d);

  if (!all.length) {
    ui.render(
      ctx.root,
      ui.card(
        ui.empty(`${ctx.range.label}没有行驶、充电或停车记录。`, {
          icon: "timeline-clock-outline",
          title: "这段时间没有记录",
          action: ctx.range.key !== "7d" ? ui.button("看最近 7 天", { kind: "soft", href: ctx.href("/stats/timeline", { r: null }) }) : null
        })
      )
    );
    return;
  }

  ui.render(
    ctx.root,
    html`<div class="pg-tl-layout">
      <div class="pg-tl-aside">
        <div id="pg-tl-stats"></div>
        ${filterCard(f)}
      </div>
      <div class="pg-tl-main">
        <div id="pg-tl-days" class="pg-tl-days"></div>
        <div id="pg-tl-more"></div>
      </div>
    </div>`
  );

  const statsEl = ctx.root.querySelector("#pg-tl-stats");
  const daysEl = ctx.root.querySelector("#pg-tl-days");
  const moreEl = ctx.root.querySelector("#pg-tl-more");
  const chipsEl = ctx.root.querySelector("#pg-tl-chips");
  const input = ctx.root.querySelector("#pg-tl-q");

  // 当前显示的事件、已经画出来的条数；展开的明细按事件在 shown 里的下标找
  let text = f.text;
  let shown = [];
  let limit = PAGE;

  const draw = () => {
    const byText = matchText(all, text);
    ui.render(chipsEl, chips(countByType(byText), f.types));
    shown = f.types.length ? byText.filter((e) => f.types.includes(e.type)) : byText;
    // 汇总跟着筛选走（和行程页一样）：搜「千佛山」时上面就是去千佛山的里程、停了多久
    ui.render(statsEl, summaryStats(shown, f.types));
    if (!shown.length) {
      ui.render(
        daysEl,
        ui.card(
          ui.empty(text ? `没有和「${text}」有关的记录。` : "这段时间没有这类记录。", {
            icon: "filter-variant",
            title: "没有符合条件的记录",
            action: ui.button("清除筛选", { kind: "soft", attrs: { "data-tl-clear": "" } })
          })
        )
      );
      ui.render(moreEl, "");
      return;
    }
    const page = shown.slice(0, limit);
    const groups = groupByDay(page, shown);
    ui.render(daysEl, groups.map((g) => dayGroup(g, ctx)));
    markExpandable(daysEl, groups);
    const left = shown.length - page.length;
    ui.render(
      moreEl,
      left > 0
        ? html`<div class="pg-tl-more">${ui.button(`再显示 ${Math.min(PAGE, left)} 条`, { kind: "soft", attrs: { "data-tl-more": "" } })}<span class="tm-note">还有 ${left} 条</span></div>`
        : shown.length > PAGE
          ? html`<p class="tm-note pg-tl-end">共 ${shown.length} 条，已全部显示</p>`
          : ""
    );
  };

  draw();

  // ---- 交互
  ctx.root.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-type]");
    if (chip) {
      const k = chip.dataset.type;
      // 从「全部」点某一类：只看这一类；之后再点别的类是加上 / 去掉
      let next;
      if (!k) next = [];
      else if (!f.types.length) next = [k];
      else next = f.types.includes(k) ? f.types.filter((x) => x !== k) : [...f.types, k];
      ctx.setQuery({ types: next.length && next.length < TYPE_KEYS.length ? next.join(",") : null, q: text || null });
      return;
    }
    if (e.target.closest("[data-tl-clear]")) {
      // 搜索框里打了字但没按回车时 URL 里没有 q，setQuery 什么都不会变（也不重画），得在这里自己清
      if (f.types.length || f.text) ctx.setQuery({ types: null, q: null });
      else {
        input.value = "";
        text = "";
        limit = PAGE;
        draw();
      }
      return;
    }
    if (e.target.closest("[data-tl-more]")) {
      limit += PAGE;
      draw();
      return;
    }
    const row = e.target.closest("[data-x]");
    if (row && !e.target.closest("a, button")) toggleRow(row, shown, ctx);
  });

  ctx.root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("[data-x]");
    if (!row || e.target !== row) return;
    e.preventDefault();
    toggleRow(row, shown, ctx);
  });

  // 搜索：边打边筛（数据都在手上）；回车再写进 URL，返回这一页时还在
  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      text = input.value.trim().slice(0, 60);
      limit = PAGE;
      draw();
    }, 150);
  });
  ctx.onCleanup(() => clearTimeout(timer));
  ctx.root.querySelector("#pg-tl-search").addEventListener("submit", (e) => {
    e.preventDefault();
    input.blur();
    ctx.setQuery({ q: input.value.trim().slice(0, 60) || null });
  });
}

// ---------------------------------------------------------------- 顶部汇总

// 库里的充入电量、费用都是两位小数，按分取整再累加：不然 0.1 + 0.2 这类浮点误差让 207.05 显示成 207.0
const add2 = (a, b) => Math.round((a + (+b || 0)) * 100) / 100;

// 宫格小字「1004 次 · 11天22小时」：320 宽放不下时整项藏掉后面的，不截成半截
function statFit(items) {
  return html`<span class="pg-tl-stat-fit">${items.filter(Boolean).map((x) => html`<span>${x}</span>`)}</span>`;
}

// types：筛选选中的事件类型（空 = 全部）。没选的那一类写「没选」，不写 0（范围里其实有，只是筛掉了）
function summaryStats(events, types) {
  let dn = 0, dist = 0, dmin = 0, cn = 0, kwh = 0, cost = null, pn = 0, pmin = 0, pkwh = 0, pe = 0;
  for (const e of events) {
    const r = e.row;
    if (e.type === "drive") {
      dn++;
      dist += +r.distance || 0;
      dmin += +r.duration_min || 0;
    } else if (e.type === "charge") {
      cn++;
      kwh = add2(kwh, r.energy_added);
      if (r.cost != null) cost = add2(cost || 0, r.cost);
    } else if (e.type === "park") {
      pn++;
      pmin += parkMinutes(r) || 0;
      if (r.energy != null) {
        pe++;
        pkwh += +r.energy;
      }
    }
  }
  const off = (k) => types.length > 0 && !types.includes(k);
  const OFF = "筛选里没选";
  return ui.stats([
    off("drive")
      ? { label: "行驶", icon: "road-variant", value: null, sub: OFF }
      : { label: "行驶", icon: "road-variant", value: dn ? fmt.num(dist, dist >= 100 ? 0 : 1) : "0", unit: fmt.unit.len, sub: dn ? statFit([`${fmt.int(dn)} 次`, fmt.duration(dmin)]) : "没有行驶" },
    off("charge")
      ? { label: "充电", icon: "ev-station", value: null, sub: OFF }
      : { label: "充电", icon: "ev-station", value: cn ? fmt.num(kwh, 1) : "0", unit: "kWh", sub: cn ? statFit([`${fmt.int(cn)} 次`, cost != null && fmt.money(cost)]) : "没有充电" },
    { label: "停车", icon: ICON_PARK, value: pn ? fmt.duration(pmin) : null, sub: pn ? `${fmt.int(pn)} 次` : off("park") ? OFF : null },
    // 停车时续航掉了多少（面板 Energy Diff 列的合计），正数表示掉电
    // 还停着的那段没有结束时的续航，算不出来；只有它一段时写「—」，不写 0.0
    { label: "停车耗电", icon: "battery-50", value: pe ? fmt.num(Math.max(0, -pkwh), 1) : null, unit: "kWh", sub: pe ? "按续航减少估算" : pn ? "停车还没结束" : off("park") ? OFF : null }
  ]);
}

// ---------------------------------------------------------------- 筛选

function chips(counts, types) {
  return html`<button type="button" class="tm-chip" data-type="" aria-pressed="${types.length ? "false" : "true"}">全部</button>
    ${TYPES.filter((t) => counts[t.key] > 0 || types.includes(t.key)).map(
      (t) => html`<button type="button" class="tm-chip pg-tl-chip is-${t.key}" data-type="${t.key}" aria-pressed="${types.includes(t.key) ? "true" : "false"}">
        ${ui.icon(t.icon)}<span>${t.label}</span><span class="pg-tl-chip-n tm-num">${counts[t.key]}</span>
      </button>`
    )}`;
}

function filterCard(f) {
  return ui.card(
    html`<div class="pg-tl-filter">
      <div class="pg-tl-chips" id="pg-tl-chips" role="group" aria-label="事件类型"></div>
      <form class="pg-tl-search" id="pg-tl-search" role="search">
        ${ui.icon("magnify")}
        <input class="tm-input" id="pg-tl-q" type="search" name="q" value="${f.text}" maxlength="60" placeholder="搜索地点或版本号" aria-label="搜索地点或版本号" enterkeyhint="search" autocomplete="off">
      </form>
    </div>`
  );
}

// ---------------------------------------------------------------- 按天分组

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// page：这一页要画的事件；all：筛选后的全部事件（组头合计按整天算，分页时这一天可能只画了一部分）
function groupByDay(page, all) {
  const totals = new Map();
  for (const e of all) {
    const k = dayStart(e.start);
    const t = totals.get(k) || { dist: 0, kwh: 0, dn: 0, cn: 0 };
    if (e.type === "drive") {
      t.dn++;
      t.dist += +e.row.distance || 0;
    } else if (e.type === "charge") {
      t.cn++;
      t.kwh = add2(t.kwh, e.row.energy_added);
    }
    totals.set(k, t);
  }
  const groups = [];
  let g = null;
  page.forEach((e, i) => {
    const k = dayStart(e.start);
    if (!g || g.day !== k) {
      g = { day: k, events: [], first: i, total: totals.get(k) };
      groups.push(g);
    }
    g.events.push(e);
  });
  return groups;
}

function dayGroup(g, ctx) {
  const t = g.total;
  const parts = [t.dn ? fmt.len(t.dist, 1) : null, t.cn ? `充电 ${fmt.kwh(t.kwh, 1)}` : null].filter(Boolean);
  return html`<section class="pg-tl-day">
    <div class="pg-tl-day-head">
      <h3>${fmt.day(g.day)}</h3>
      ${parts.length ? html`<span class="tm-num">${parts.join(" · ")}</span>` : ""}
    </div>
    ${ui.card(ui.list(g.events.map((e) => item(e, ctx))), { pad: false })}
  </section>`;
}

// ---------------------------------------------------------------- 列表行

// 标题最多两行（和 _drive-item.js 一样）：「千佛山景区（北门停车场）」这种长地名一行放不下
function titleHtml(text) {
  return html`<span class="pg-tl-title">${text}</span>`;
}

// 一行放得下几项就显示几项、放不下的整项藏起来（和 _drive-item.js 的次要信息一样）
function fitLine(items) {
  return html`<span class="pg-tl-fit">${items.filter(Boolean).map((x) => html`<span>${x}</span>`)}</span>`;
}

function metaItem(iconName, label, text) {
  return html`<span class="tm-num">${ui.icon(iconName, { label })} ${text}</span>`;
}

function signed(v, d, unit) {
  if (v == null || !Number.isFinite(+v)) return null;
  const s = fmt.num(v, d);
  return `${+s.replace(/,/g, "") > 0 ? "+" : ""}${s}${unit ? " " + unit : ""}`;
}

function socText(a, b) {
  return a != null && b != null ? `${a}→${b}%` : null;
}

// 最后那段停车之后正在进行的事（LIVE_SQL）
function liveTag(kind) {
  return kind === "drive" ? ui.pill("已出发，正在行驶", "accent", { icon: "road-variant" }) : ui.pill("已插枪，正在充电", "green", { icon: "ev-station" });
}

// 结束时间：同一天只写时刻，第二天写「次日」，再往后写日期
function endText(start, end) {
  if (end == null) return "";
  if (dayStart(end) === dayStart(start)) return fmt.time(end);
  if (dayStart(end) - dayStart(start) <= 25 * 3600e3) return `次日 ${fmt.time(end)}`;
  return fmt.dateTime(end);
}

function span(start, end) {
  return end == null ? `${fmt.time(start)} 起` : `${fmt.time(start)}–${endText(start, end)}`;
}

// 停车行的副标题单独一行：「20:21–次日 07:56」在 320 宽的屏上放不下，从「–」后面折行，别把结束时间截掉
function spanWrap(start, end) {
  if (end == null) return span(start, end);
  return html`<span class="pg-tl-span"><span>${fmt.time(start)}–</span><span>${endText(start, end)}</span></span>`;
}

function ymd(ms) {
  return fmt.isoDate(ms).replace(/-/g, "");
}

function item(e, ctx) {
  const r = e.row;
  switch (e.type) {
    case "drive":
      return driveItem(r, ctx, { date: false });
    case "charge":
      return chargeItem(r, ctx, { date: false });
    case "park": {
      // 停车最要紧的是停了多久，其次是掉了多少电（和行驶的「距离 / 能耗」、充电的「电量 / 费用」对应）
      const ongoing = r.end_date == null;
      return {
        icon: ICON_PARK,
        tone: "cyan",
        title: titleHtml(r.place || UNKNOWN_PLACE),
        sub: spanWrap(r.start_date, r.end_date),
        meta: ongoing
          ? ui.pill("停车中", "cyan")
          : r.live
            ? liveTag(r.live)
            : fitLine([
                socText(r.start_soc, r.end_soc) && metaItem("battery-50", "电量", socText(r.start_soc, r.end_soc)),
                r.range_diff != null && html`<span class="tm-num">续航 ${signed(r.range_diff, 1, fmt.unit.len)}</span>`
              ]),
        value: fmt.duration(parkMinutes(r)),
        valueSub: ongoing || r.live ? null : signed(r.energy, 1, "kWh")
      };
    }
    case "missing":
      return {
        icon: ICON_MISSING,
        tone: "amber",
        title: titleHtml(`${r.start_place || UNKNOWN_PLACE} → ${r.end_place || UNKNOWN_PLACE}`),
        sub: fitLine([span(r.start_date, r.end_date), fmt.duration(r.duration_min)]),
        meta: html`${ui.pill("数据缺失", "amber")}${socText(r.start_soc, r.end_soc) ? metaItem("battery-50", "电量", socText(r.start_soc, r.end_soc)) : ""}`,
        value: r.distance != null ? `+${fmt.len(r.distance, 1)}` : null,
        valueSub: "没有记录"
      };
    case "update":
      return {
        icon: "update",
        tone: "violet",
        title: `软件更新 ${shortVersion(r.version) || ""}`,
        sub: fitLine([span(r.start_date, r.end_date), r.duration_min != null ? `用时 ${fmt.duration(r.duration_min)}` : "没有结束记录"])
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 展开明细（停车、数据缺失、软件更新）

// ui.list 画出来的行按顺序对应事件：没有详情页的三类，给行加上「点一下展开」
function markExpandable(daysEl, groups) {
  const sections = daysEl.querySelectorAll(".pg-tl-day");
  groups.forEach((g, gi) => {
    const rows = sections[gi] ? sections[gi].querySelectorAll(".tm-list > .tm-row") : [];
    g.events.forEach((e, i) => {
      const row = rows[i];
      if (!row || e.type === "drive" || e.type === "charge") return;
      row.classList.add("pg-tl-x");
      row.dataset.x = String(g.first + i);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", "false");
      row.insertAdjacentHTML("beforeend", String(ui.icon("chevron-down", { cls: "pg-tl-x-icon" })));
    });
  });
}

function toggleRow(row, shown, ctx) {
  const open = row.getAttribute("aria-expanded") === "true";
  const next = row.nextElementSibling;
  if (open) {
    if (next && next.classList.contains("pg-tl-panel")) next.remove();
    row.setAttribute("aria-expanded", "false");
    return;
  }
  const e = shown[+row.dataset.x];
  if (!e) return;
  const panel = document.createElement("div");
  panel.className = "pg-tl-panel";
  ui.render(panel, details(e, ctx));
  row.after(panel);
  row.setAttribute("aria-expanded", "true");
}

function when(ms) {
  return ms == null ? null : `${fmt.dateAuto(ms)} ${fmt.weekday(ms)} ${fmt.time(ms)}`;
}

// 收藏点（TeslaMate 自己的地理围栏页面）：已经在围栏里就编辑，否则按这个位置新建。面板里的「Create or edit geo-fence」
function geofenceLink(geofenceId, lat, lng, label) {
  if (Number.isSafeInteger(geofenceId) && geofenceId > 0) {
    return ui.button(`编辑收藏点${label || ""}`, { href: `/geo-fences/${geofenceId}/edit`, small: true, icon: "map-marker-radius" });
  }
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return ui.button(`设为收藏点${label || ""}`, {
      href: `/geo-fences/new?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
      small: true,
      icon: "map-marker-radius"
    });
  }
  return null;
}

function details(e, ctx) {
  const r = e.row;
  if (e.type === "park") {
    // 还停着、或者之后的行驶 / 充电还没结束：停车结束时的电量、续航还不知道
    const open = r.end_date == null || r.live;
    const end = r.end_date == null ? "还停着" : r.live ? `${when(r.end_date)}（${r.live === "drive" ? "出发了，还在路上" : "开始充电，还没充完"}）` : when(r.end_date);
    // 面板这一行的链接是 Trip 面板的这段时间；停车期间值得看的是车在睡还是醒着（和待机掉电页一样链到状态页）
    const states = ctx.href("/stats/states", { r: `${ymd(r.start_date)}-${ymd(r.end_date ?? Date.now())}` });
    return html`${ui.kv(
      [
        ["地点", r.place_full || r.place],
        ["开始", when(r.start_date)],
        ["结束", end],
        ["时长", fmt.duration(parkMinutes(r))],
        open ? ["停车时电量", r.start_soc != null ? `${r.start_soc}%` : null] : ["电量", r.start_soc != null && r.end_soc != null ? `${r.start_soc}% → ${r.end_soc}%` : null],
        !open && ["续航", r.end_range != null ? `${fmt.len(r.end_range, 1)}（${signed(r.range_diff, 1, fmt.unit.len) || "—"}）` : null],
        !open && ["耗电", signed(r.energy, 2, "kWh")],
        ["里程表", fmt.len(r.odometer, 1)]
      ],
      { cols: 2 }
    )}
      <div class="tm-flex pg-tl-actions">
        ${geofenceLink(r.geofence_id, r.latitude, r.longitude)}
        ${ui.button("停车期间的状态", { href: states, small: true, icon: "list-status" })}
      </div>`;
  }
  if (e.type === "missing") {
    return html`<p class="tm-note pg-tl-panel-note">TeslaMate 这段时间没有记录，但车从「${r.start_place || UNKNOWN_PLACE}」到了「${r.end_place || UNKNOWN_PLACE}」，里程表多了 ${fmt.len(r.distance, 1)}。</p>
      ${ui.kv(
        [
          ["起点", r.start_full || r.start_place],
          ["终点", r.end_full || r.end_place],
          ["停止记录", when(r.start_date)],
          ["恢复记录", when(r.end_date)],
          ["间隔", fmt.duration(r.duration_min)],
          ["距离", fmt.len(r.distance, 1)],
          ["电量", r.start_soc != null && r.end_soc != null ? `${r.start_soc}% → ${r.end_soc}%` : null],
          ["续航", r.start_range != null && r.end_range != null ? `${fmt.len(r.start_range, 1)} → ${fmt.len(r.end_range, 1)}` : null],
          // 面板的 Range Diff / Energy Diff：续航变化扣掉里程表的变化，差不多是开车以外掉的电
          ["扣除行驶后的续航变化", signed(r.range_diff, 1, fmt.unit.len)],
          ["折合电量", signed(r.energy, 2, "kWh")],
          ["里程表", fmt.len(r.odometer, 1)]
        ],
        { cols: 2 }
      )}
      <div class="tm-flex pg-tl-actions">
        ${geofenceLink(r.start_geofence_id, r.start_lat, r.start_lng, "（起点）")}
        ${geofenceLink(r.end_geofence_id, r.end_lat, r.end_lng, "（终点）")}
      </div>`;
  }
  // 软件更新
  const v = shortVersion(r.version);
  const notes = releaseNotes(v);
  return html`${ui.kv(
    [
      ["版本", r.version],
      ["开始", when(r.start_date)],
      ["结束", when(r.end_date)],
      ["用时", fmt.duration(r.duration_min)]
    ],
    { cols: 2 }
  )}
    <div class="tm-flex pg-tl-actions">
      ${notes ? ui.button("更新说明", { href: notes, small: true, icon: "open-in-new", attrs: { target: "_blank", rel: "noopener" } }) : ""}
      ${ui.button("全部软件更新", { href: ctx.href("/stats/updates"), small: true, icon: "update" })}
    </div>`;
}

// 「2026.32.1 429934134f」→「2026.32.1」（面板也是取空格前面那段）
function shortVersion(v) {
  return v ? String(v).split(" ")[0] : null;
}

// 版本号只放行「数字.数字…」这种，别把数据库里的任意文本拼进链接
function releaseNotes(v) {
  return v && /^\d{4}\.\d{1,3}(\.\d{1,3}){0,3}$/.test(v) ? `https://www.notateslaapp.com/software-updates/version/${v}/release-notes` : null;
}

