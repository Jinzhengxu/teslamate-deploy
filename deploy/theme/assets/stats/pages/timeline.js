// 时间线（对应 Grafana「Timeline」面板 SUBgwtigz）：行驶、充电、停车、数据缺失、软件更新按时间倒序排成一条流。
// 面板是一条五段 UNION 的 SQL，这里拆成五条查询一次 batch 取回，在前端合并、筛选、分组：
//   - 行驶 / 充电直接用 _drive-item.js / _charge-item.js 的 SQL 和列表行，和行程、充电页长得一样，点进去是详情；
//     没结束的也列出来（面板不列），按 _shared.js 的口径分成「充电中 / 行驶中」和「未完成」（中途断掉），不计入汇总和每天的合计；
//   - 停车、数据缺失、软件更新的 SQL 照抄面板（改动见各自的注释），行点一下展开明细（面板里的里程表、续航、收藏点链接等都在里面）。
// 事件类型、地点搜索都在前端筛：数据已经在手上，筛选不用再等服务器。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import { DRIVE_ITEM_SQL, driveItem, lenText, lenDigits, timeSpan, endTime, metaItem } from "./_drive-item.js";
import { CHARGE_ITEM_SQL, chargeItem } from "./_charge-item.js";
import { placeSql, placeFullSql, panelAddressSql, UNKNOWN_PLACE, LIVE_SQL, shortVersion, releaseNotes } from "./_shared.js";

export const title = "时间线";
export const range = { default: "7d" };
export const css = true;

// 一次画 50 条，「再显示」往后加：「全部」范围有两千多条，一次都画出来手机会卡
const PAGE = 50;

// 事件类型：顺序即筛选标签的顺序；grafana 是面板 action_filter 变量里对应的值
const TYPES = [
  { key: "drive", label: "行驶", icon: "road-variant", grafana: "🚗 Driving" },
  { key: "charge", label: "充电", icon: "ev-station", grafana: "🔋 Charging" },
  { key: "park", label: "停车", icon: "parking", grafana: "🅿️ Parking" },
  { key: "missing", label: "数据缺失", icon: "map-marker-question-outline", grafana: "❓ Missing" },
  { key: "update", label: "软件更新", icon: "update", grafana: "💾 Updating" }
];
const TYPE_KEYS = TYPES.map((t) => t.key);
// 同一时刻开始的两条（极少见）按这个顺序排
const TYPE_RANK = { update: 0, missing: 1, charge: 2, drive: 3, park: 4 };

// ---------------------------------------------------------------- SQL

// 搜索地点时匹配两样：列表上显示的短地名，和面板搜索用的完整地址（*_panel，_shared.js panelAddressSql，
// 这样搜到的和 Grafana 面板一样）。展开明细里显示的完整地址（*_full）用 placeFullSql，和行程、充电详情页写法一致

// 行驶：_drive-item.js 的 SQL 外面再包一层，补上面板搜索用的完整地址
const DRIVES_SQL = `select x.*, ${panelAddressSql("sg", "sa")} as start_panel, ${panelAddressSql("eg", "ea")} as end_panel
from (${DRIVE_ITEM_SQL("$__timeFilter(d.start_date)", { incomplete: true })}) x
join drives d on d.id = x.id
left join addresses sa on sa.id = d.start_address_id
left join addresses ea on ea.id = d.end_address_id
left join geofences sg on sg.id = d.start_geofence_id
left join geofences eg on eg.id = d.end_geofence_id`;

// 充电：同上。_charge-item.js 默认不含充进 0 kWh 的充电，和面板的 charge_energy_added > 0 一致
const CHARGES_SQL = `select x.*, ${panelAddressSql("g", "a")} as place_panel
from (${CHARGE_ITEM_SQL("$__timeFilter(cp.start_date)", { incomplete: true })}) x
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
  ${placeSql("g", "ad")} as place, ${placeFullSql("g", "ad")} as place_full, ${panelAddressSql("g", "ad")} as place_panel,
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
  ${placeFullSql("g1", "a1")} as start_full, ${placeFullSql("g2", "a2")} as end_full,
  ${panelAddressSql("g1", "a1")} as start_panel, ${panelAddressSql("g2", "a2")} as end_panel,
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

// ---------------------------------------------------------------- 筛选参数（URL → 校验过的值）

function readFilters(q) {
  const raw = (q.get("types") || "").split(",").filter((k) => TYPE_KEYS.includes(k));
  // 全选和不选都当「全部」，URL 里不写
  const types = raw.length && raw.length < TYPE_KEYS.length ? TYPE_KEYS.filter((k) => raw.includes(k)) : [];
  const text = (q.get("q") || "").trim().slice(0, 60);
  return { types, text };
}

// 页头「在 Grafana 中打开」带上同样的筛选。多选时 Grafana 要重复的 var-action_filter 参数，链接工具只能带一个值，只选一类时才带
function grafanaVars(f) {
  return {
    "var-action_filter": f.types.length === 1 ? TYPES.find((t) => t.key === f.types[0]).grafana : null,
    "var-text_filter": f.text || null
  };
}

// ---------------------------------------------------------------- 数据 → 事件

const lower = (...xs) => xs.filter((x) => x != null && x !== "").join("\n").toLowerCase();

// live：这辆车现在正在进行的行驶 / 充电（_shared.js LIVE_SQL）。TeslaMate 开始时就建了这一行、结束才填 end_date，
// 所以停车查询看不到它，最后那段停车会一直「停车中」算到现在 —— 车其实已经开走了 / 插上枪了
function toEvents(d) {
  const out = [];
  const live = d.live[0] || null;
  for (const r of d.drives) {
    out.push({ type: "drive", start: r.start_date, end: r.end_date, row: r, hay: lower(r.start_place, r.end_place, r.start_panel, r.end_panel) });
  }
  for (const r of d.charges) {
    out.push({ type: "charge", start: r.start_date, end: r.end_date, row: r, hay: lower(r.place, r.place_panel) });
  }
  for (let r of d.park) {
    // 最后那段停车之后车正在开 / 正在充：停车到它开始为止（行对象和缓存共用，复制一份再改）
    if (r.end_date == null && live && live.start_date > r.start_date) {
      r = { ...r, end_date: live.start_date, duration_min: (live.start_date - r.start_date) / 60e3, live: live.kind };
    }
    out.push({ type: "park", start: r.start_date, end: r.end_date, row: r, hay: lower(r.place, r.place_panel) });
  }
  for (const r of d.missing) {
    out.push({ type: "missing", start: r.start_date, end: r.end_date, row: r, hay: lower(r.start_place, r.end_place, r.start_panel, r.end_panel) });
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

// 行驶、充电里没结束的（正在进行、中途断掉）不计入汇总和每天的合计，和行程、充电页一样：时长、电量都只记了一部分
const counted = (e) => (e.type !== "drive" && e.type !== "charge") || e.end != null;

// 还在停着（最后一次行驶 / 充电之后没有新记录）：时长算到现在
function parkMinutes(r) {
  if (r.duration_min != null) return r.duration_min;
  return r.end_date == null ? Math.max(0, (Date.now() - r.start_date) / 60e3) : null;
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const f = readFilters(ctx.query);
  ctx.setGrafanaVars(grafanaVars(f));
  ctx.root.classList.add("pg-tl");

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
          title: "没有行驶和充电",
          action: !ctx.range.isDefault ? ui.button("看最近 7 天", { kind: "soft", href: ctx.href("/stats/timeline", { r: null }) }) : null
        })
      )
    );
    return;
  }

  // 布局和行程、充电列表一样（.tm-list-layout）：手机、平板一列，筛选条收成一行（手机上汇总再缩小一号），首屏留给记录；
  // 桌面左栏放筛选和汇总（不高，is-sticky 跟着滚动停在顶上，翻到哪天都能看到汇总、切类型），右栏是事件流
  ui.render(
    ctx.root,
    html`<div class="tm-list-layout is-sticky">
      <div class="tm-list-aside">
        ${filterBar(f, ctx)}
        <div id="pg-tl-stats"></div>
      </div>
      <div class="tm-list-main"><div id="pg-tl-days"></div></div>
    </div>`
  );

  const statsEl = ctx.root.querySelector("#pg-tl-stats");
  const daysEl = ctx.root.querySelector("#pg-tl-days");
  const chipsEl = ctx.root.querySelector("#pg-tl-chips");
  const input = ctx.root.querySelector("#pg-tl-q");

  // 正在按哪段文字筛（f.text 是 URL 里的 q，打字时由 setText 跟上）；timer：打字的防抖
  let text = f.text;
  let timer = 0;

  const draw = () => {
    const byText = matchText(all, text);
    ui.render(chipsEl, chips(countByType(byText), f.types));
    const shown = f.types.length ? byText.filter((e) => f.types.includes(e.type)) : byText;
    // 汇总跟着筛选走（和行程页一样）：搜「千佛山」时上面就是去千佛山的里程、停了多久
    ui.render(statsEl, summaryStats(shown, f.types));
    if (!shown.length) {
      ui.render(
        daysEl,
        ui.card(
          ui.empty(text ? `没有和「${text}」有关的记录。` : `${ctx.range.label}没有这类记录。`, {
            icon: "filter-variant",
            title: "没有符合条件的记录",
            action: ui.button("清除筛选", { kind: "soft", attrs: { "data-tl-clear": "" } })
          })
        )
      );
      return;
    }
    // 组头合计按整天算（分页时这一天可能只画了一部分；pager 并组时保留第一次画的组头）
    const totals = dayTotals(shown);
    ui.pager(daysEl, {
      total: shown.length,
      page: PAGE,
      noun: "条记录",
      load: (offset) =>
        groupByDay(shown.slice(offset, offset + PAGE)).map((g) =>
          ui.dayGroup(fmt.day(g.day), totalText(totals.get(g.key)), ui.card(ui.list(g.events.map((e) => item(e, ctx))), { pad: false }), { key: g.key })
        )
    });
  };

  draw();

  // ---- 交互（展开 / 收起筛选条、「清除」、展开明细由核心处理）
  ctx.root.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-type]");
    if (chip) {
      const k = chip.dataset.type;
      // 从「全部」点某一类：只看这一类；之后再点别的类是加上 / 去掉
      let next;
      if (!k) next = [];
      else if (!f.types.length) next = [k];
      else next = f.types.includes(k) ? f.types.filter((x) => x !== k) : [...f.types, k];
      ctx.setQuery({ types: next.length && next.length < TYPE_KEYS.length ? next.join(",") : null });
      return;
    }
    if (e.target.closest("[data-tl-clear]")) {
      // 只有搜索词时 setText 就够了（不用重画整页，URL 里的 q 它会去掉）；有类型要换一份类型标签，重画整页
      if (f.types.length) ctx.setQuery({ types: null, q: null });
      else {
        input.value = "";
        setText("");
      }
    }
  });

  // 搜索：边打边筛（数据都在手上），同时把 q 写进 URL 和筛选条的摘要。URL 只用 history.replaceState 改，不走 ctx.setQuery：
  // 那会重画整页，正在打字的输入框丢焦点。这样不管之后是按 Tab、点一行、点「上一段」还是刷新，URL、摘要和列表都是同一个词
  // （以前回车才写进 URL，删光后没回车就离开时 q 还留着，别的控件一重画又筛回去了）
  const setText = (next) => {
    clearTimeout(timer);
    if (next !== text && input.isConnected) {
      text = next;
      draw();
    }
    syncQuery(next);
  };
  // 只改 URL、摘要和 Grafana 链接，不动列表
  const syncQuery = (next) => {
    // 离开这一页（或整页重画）时输入框被拿掉也会触发 blur，这时 URL 已经是别的页了，不能再写 q
    if (next === f.text || ctx.signal.aborted || !input.isConnected) return;
    f.text = next;
    const u = new URL(location.href);
    if (next) u.searchParams.set("q", next);
    else u.searchParams.delete("q");
    // 列表换了一份，ui.pager 记在这条历史记录上的「已显示几条」不再作数（和 app.js 的 setQuery 一样）
    history.replaceState({ ...history.state, pager: undefined }, "", u);
    ctx.setGrafanaVars(grafanaVars(f));
    syncBar();
  };
  // 筛选条摘要（「筛选 · 1 含「家」 清除」）按新的 f 重做。整个筛选条不能重画（输入框在里面），只换上面那一行；
  // 展开的面板还是原来那个，按钮上的 aria-controls、aria-expanded 照旧
  const syncBar = () => {
    const bar = ctx.root.querySelector(".tm-filter-bar");
    const tpl = document.createElement("template");
    tpl.innerHTML = String(filterBar(f, ctx));
    const fresh = tpl.content.querySelector(".tm-filter-bar");
    const oldBtn = bar.querySelector("[data-tm-filter-toggle]");
    const btn = fresh.querySelector("[data-tm-filter-toggle]");
    for (const k of ["aria-controls", "aria-expanded"]) btn.setAttribute(k, oldBtn.getAttribute(k));
    bar.replaceWith(fresh);
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => setText(input.value.trim().slice(0, 60)), 150);
  });
  ctx.onCleanup(() => clearTimeout(timer));
  const flush = () => setText(input.value.trim().slice(0, 60));
  // 点「×」、按 Esc 清空时不用等防抖
  input.addEventListener("search", flush);
  // 刚打完字就离开输入框（马上点了「上一段」、类型标签这类会重画整页的控件）：URL 先跟上，重画时才带对 q。
  // 列表还是等防抖：按下时就重画列表，松开时的点击会落空（点的正好是一行时就进不去详情了）
  input.addEventListener("blur", () => syncQuery(input.value.trim().slice(0, 60)));
  // 回车：列表已经跟着筛过了，这里只收起键盘
  ctx.root.querySelector("#pg-tl-search").addEventListener("submit", (e) => {
    e.preventDefault();
    flush();
    input.blur();
  });
}

// ---------------------------------------------------------------- 顶部汇总

// 库里的充入电量、费用都是两位小数，按分取整再累加：不然 0.1 + 0.2 这类浮点误差让 207.05 显示成 207.0
const add2 = (a, b) => Math.round((a + (+b || 0)) * 100) / 100;

// types：筛选选中的事件类型（空 = 全部）。没选的那一类写「没选」，不写 0（范围里其实有，只是筛掉了）
function summaryStats(events, types) {
  let dn = 0, dist = 0, dmin = 0, cn = 0, kwh = 0, cost = null, pn = 0, pmin = 0, pkwh = 0, pe = 0;
  // 没结束的行驶 / 充电不计入，但得说一声：只有它们时不能说「没有充电」（下面的列表里明明有一行）；
  // 和结束了的混在一起时，类型标签上的条数（列表里每一行都算）和这里的次数对不上
  const open = { drive: 0, charge: 0 };
  for (const e of events) {
    if (!counted(e)) {
      open[e.type]++;
      continue;
    }
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
  const drain = pe ? Math.max(0, -pkwh) : null;
  const none = (k, text) => (open[k] ? `${fmt.int(open[k])} 次没结束，不计入` : text);
  const also = (k) => open[k] > 0 && `另 ${fmt.int(open[k])} 次没结束`;
  return ui.stats(
    [
      off("drive")
        ? { label: "行驶", icon: "road-variant", value: null, sub: OFF }
        : { label: "行驶", icon: "road-variant", value: dist, digits: dn ? lenDigits(dist) : 0, unit: fmt.unit.len, sub: dn ? ui.segs([`${fmt.int(dn)} 次`, fmt.hours(dmin), also("drive")]) : none("drive", "没有行驶") },
      off("charge")
        ? { label: "充电", icon: "ev-station", value: null, sub: OFF }
        : // 「全部」范围可能上万度，320 宽放不下小数
          { label: "充电", icon: "ev-station", value: kwh, digits: cn && kwh < 10000 ? 1 : 0, unit: "kWh", sub: cn ? ui.segs([`${fmt.int(cn)} 次`, cost != null && fmt.money(cost), also("charge")]) : none("charge", "没有充电") },
      { label: "停车", icon: "parking", value: pn ? fmt.duration(pmin) : null, sub: pn ? `${fmt.int(pn)} 次` : off("park") ? OFF : null },
      // 停车时续航掉了多少（面板 Energy Diff 列的合计），正数表示掉电
      // 还停着的那段没有结束时的续航，算不出来；只有它一段时写「—」，不写 0.0
      { label: "停车耗电", icon: "lightning-bolt", value: drain, digits: 1, unit: "kWh", sub: pe ? "按续航减少估算" : pn ? "停车还没结束" : off("park") ? OFF : null }
    ],
    // 手机上收紧一点：时间线要的是一打开就看到记录（390×844 首屏露出三条）
    { cols: 4, dense: true }
  );
}

// ---------------------------------------------------------------- 筛选条（ui.filterBar，和行程、充电列表同一个样子）

// 展开与否放模块里：改筛选会重画整页（新 root），不然每点一个类型就收起来。
// 第一次打开时桌面上展开（左栏地方够，类型和搜索框一眼就看到），手机上收起，首屏留给记录
let filterOpen = null;

function filterBar(f, ctx) {
  const summary = [];
  if (f.types.length) summary.push(f.types.map((k) => TYPES.find((t) => t.key === k).label).join("、"));
  if (f.text) summary.push(`含「${f.text}」`);
  return ui.filterBar({
    summary,
    hint: "按类型、地点或版本号筛选",
    open: filterOpen ?? window.matchMedia("(min-width: 1024px)").matches,
    onToggle: (o) => (filterOpen = o),
    onClear: () => ctx.setQuery({ types: null, q: null }),
    autofocus: true,
    body: html`
      <div class="tm-field">
        <span>类型</span>
        <div class="pg-tl-chips" id="pg-tl-chips" role="group" aria-label="事件类型"></div>
      </div>
      <form id="pg-tl-search" role="search">
        <label class="tm-field">
          <span>地点或版本号</span>
          <span class="tm-search">
            ${ui.icon("magnify")}
            <input class="tm-input" id="pg-tl-q" type="search" name="q" value="${f.text}" maxlength="60" placeholder="地点、版本号包含的文字" enterkeyhint="search" autocomplete="off">
          </span>
        </label>
      </form>`
  });
}

function chips(counts, types) {
  return html`<button type="button" class="tm-chip" data-type="" aria-pressed="${types.length ? "false" : "true"}">全部</button>
    ${TYPES.filter((t) => counts[t.key] > 0 || types.includes(t.key)).map(
      (t) => html`<button type="button" class="tm-chip pg-tl-chip" data-type="${t.key}" aria-pressed="${types.includes(t.key) ? "true" : "false"}">
        ${ui.icon(t.icon)}<span>${t.label}</span><span class="pg-tl-chip-n tm-num">${counts[t.key]}</span>
      </button>`
    )}`;
}

// ---------------------------------------------------------------- 按天分组

// 按开始的本地日期分组，保持倒序
function groupByDay(events) {
  const groups = [];
  for (const e of events) {
    const key = fmt.isoDate(e.start);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(e);
    else groups.push({ key, day: e.start, events: [e] });
  }
  return groups;
}

// 每天的行驶里程、充入电量（筛选后的全部事件，不只是这一页）
function dayTotals(events) {
  const totals = new Map();
  for (const e of events) {
    if (!counted(e)) continue;
    const k = fmt.isoDate(e.start);
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
  return totals;
}

function totalText(t) {
  if (!t) return null;
  return [t.dn ? lenText(t.dist) : null, t.cn ? `充电 ${fmt.kwh(t.kwh, 1)}` : null].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- 列表行

// 显式写符号的变化量（fmt.signed：「+」「−」，四舍五入成 0 的不带符号），带上单位；没有值时返回 null，这一项不写
function signed(v, d, unit) {
  if (v == null || !Number.isFinite(+v)) return null;
  return fmt.signed(v, (x) => `${fmt.num(x, d)}${unit ? " " + unit : ""}`);
}

function socText(a, b) {
  return a != null && b != null ? `${a}→${b}%` : null;
}

// 最后那段停车之后正在进行的事（LIVE_SQL）
function liveTag(kind) {
  return kind === "drive" ? ui.pill("正在行驶", "accent", { icon: "road-variant" }) : ui.pill("正在充电", "green", { icon: "ev-station" });
}

// 停车行的时间段单独占一行：「20:21–次日 07:56」在 320 宽的屏上放不下，从「–」后面折行，别把结束时间截掉
function spanWrap(start, end) {
  return html`<span class="pg-tl-span"><span class="tm-nowrap">${fmt.time(start)}–</span><span class="tm-nowrap">${endTime(start, end)}</span></span>`;
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
      const soc = socText(r.start_soc, r.end_soc);
      return {
        icon: "parking",
        tone: "cyan",
        title: r.place || UNKNOWN_PLACE,
        sub: ongoing ? `${fmt.time(r.start_date)} 起` : spanWrap(r.start_date, r.end_date),
        meta: ongoing
          ? ui.pill("停车中", "cyan")
          : r.live
            ? liveTag(r.live)
            : ui.fit([
                soc && metaItem("battery-50", "电量", soc),
                r.range_diff != null && html`<span class="tm-num">续航 ${signed(r.range_diff, 0, fmt.unit.len)}</span>`
              ]),
        value: fmt.duration(parkMinutes(r)),
        valueSub: ongoing || r.live ? null : signed(r.energy, 1, "kWh"),
        expand: () => details(e, ctx)
      };
    }
    case "missing": {
      const soc = socText(r.start_soc, r.end_soc);
      return {
        icon: "map-marker-question-outline",
        tone: "amber",
        title: `${r.start_place || UNKNOWN_PLACE} → ${r.end_place || UNKNOWN_PLACE}`,
        sub: ui.fit([timeSpan(r.start_date, r.end_date), fmt.duration(r.duration_min)]),
        meta: html`${ui.pill("数据缺失", "amber")}${soc ? metaItem("battery-50", "电量", soc) : ""}`,
        value: r.distance != null ? `+${lenText(r.distance)}` : null,
        valueSub: "没有记录",
        expand: () => details(e, ctx)
      };
    }
    case "update":
      return {
        icon: "update",
        tone: "violet",
        title: `软件更新 ${shortVersion(r.version) || ""}`,
        sub: ui.fit(
          r.end_date == null
            ? [`${fmt.time(r.start_date)} 开始`, "没有结束记录"]
            : [timeSpan(r.start_date, r.end_date), `用时 ${fmt.duration(r.duration_min)}`]
        ),
        expand: () => details(e, ctx)
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 展开明细（停车、数据缺失、软件更新没有详情页）

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

const ymd = (ms) => fmt.isoDate(ms).replace(/-/g, "");

function details(e, ctx) {
  const r = e.row;
  if (e.type === "park") {
    // 还停着、或者之后的行驶 / 充电还没结束：停车结束时的电量、续航还不知道
    const open = r.end_date == null || r.live;
    const end = r.end_date == null ? "还停着" : r.live ? `${fmt.dateTime(r.end_date)}（${r.live === "drive" ? "出发了，还在路上" : "开始充电，还没充完"}）` : fmt.dateTime(r.end_date);
    const rangeDiff = signed(r.range_diff, 0, fmt.unit.len);
    // 面板这一行的链接是 Trip 面板的这段时间；停车期间值得看的是车在睡还是醒着（和待机掉电页一样链到状态页）
    const states = ctx.href("/stats/states", { r: `${ymd(r.start_date)}-${ymd(r.end_date ?? Date.now())}` });
    return html`${ui.kv(
      [
        ["地点", r.place_full || r.place],
        ["开始", fmt.dateTime(r.start_date)],
        ["结束", end],
        ["时长", fmt.duration(parkMinutes(r))],
        open ? ["停车时电量", r.start_soc != null ? `${r.start_soc}%` : null] : ["电量", r.start_soc != null && r.end_soc != null ? `${r.start_soc}% → ${r.end_soc}%` : null],
        !open && ["续航", r.end_range != null ? `${fmt.len(r.end_range, 0)}${rangeDiff ? `（${rangeDiff}）` : ""}` : null],
        !open && ["耗电", signed(r.energy, 1, "kWh")],
        ["里程表", fmt.len(r.odometer, 0)]
      ],
      { cols: 2 }
    )}
      <div class="tm-flex">
        ${geofenceLink(r.geofence_id, r.latitude, r.longitude)}
        ${ui.button("停车期间的状态", { href: states, small: true, icon: "list-status" })}
      </div>`;
  }
  if (e.type === "missing") {
    return html`<p class="tm-note">TeslaMate 这段时间没有记录，但车从「${r.start_place || UNKNOWN_PLACE}」到了「${r.end_place || UNKNOWN_PLACE}」，里程表多了 ${lenText(r.distance)}。</p>
      ${ui.kv(
        [
          ["起点", r.start_full || r.start_place],
          ["终点", r.end_full || r.end_place],
          ["停止记录", fmt.dateTime(r.start_date)],
          ["恢复记录", fmt.dateTime(r.end_date)],
          ["间隔", fmt.duration(r.duration_min)],
          ["距离", lenText(r.distance)],
          ["电量", r.start_soc != null && r.end_soc != null ? `${r.start_soc}% → ${r.end_soc}%` : null],
          ["续航", r.start_range != null && r.end_range != null ? `${fmt.len(r.start_range, 0)} → ${fmt.len(r.end_range, 0)}` : null],
          // 面板的 Range Diff / Energy Diff：续航变化扣掉里程表的变化，差不多是开车以外掉的电
          ["扣除行驶后的续航变化", signed(r.range_diff, 0, fmt.unit.len)],
          ["折合电量", signed(r.energy, 1, "kWh")],
          ["里程表", fmt.len(r.odometer, 0)]
        ],
        { cols: 2 }
      )}
      <div class="tm-flex">
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
      ["开始", fmt.dateTime(r.start_date)],
      ["结束", r.end_date != null ? fmt.dateTime(r.end_date) : null],
      ["用时", fmt.duration(r.duration_min)]
    ],
    { cols: 2 }
  )}
    <div class="tm-flex">
      ${notes ? ui.button("更新说明", { href: notes, small: true, icon: "open-in-new", attrs: { target: "_blank", rel: "noopener" } }) : ""}
      ${ui.button("全部软件更新", { href: ctx.href("/stats/updates"), small: true, icon: "update" })}
    </div>`;
}

