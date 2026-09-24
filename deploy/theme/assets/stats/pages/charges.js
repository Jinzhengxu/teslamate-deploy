// 充电列表（对应 Grafana「Charges」TSmNYvRRk）：
// 顶部汇总 = 面板的「Summary of this period」（就是下面表格的合计），列表 = 面板的「Charger type」表格（按天分组，或切成全部列的表格），
// 「未完成的充电」= 面板的「Incomplete Charges」。筛选对应面板的 location / charge_type / geofence / min_duration_min / cost 变量。
// 页面结构和行程列表（drives.js）保持一致：筛选条 → 汇总 → 柱状图 → 正在充电 / 未完成 → 按天分组的列表。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { CHARGE_ITEM_SQL, chargeItem, chargeKind, chargeState, groupByDay } from "./_charge-item.js";
import { UNKNOWN_PLACE } from "./_shared.js";

export const title = "充电";
export const range = { default: "90d" };
export const css = true;

// 先画 50 条，「再显示」每次加 50 条：全部范围可能有上千次充电，一次都画出来手机会卡
const PAGE = 50;
const FIX_DOC = "https://docs.teslamate.org/docs/maintenance/manually_fixing_data";

const TYPES = [
  { value: "", label: "全部" },
  { value: "AC", label: "交流慢充" },
  { value: "DC", label: "直流快充" }
];
// 四档在 320 宽的手机上也放得下一行；URL 里别的值（比如 Grafana 带过来的 15）会临时多一档
const DURATIONS = [0, 10, 30, 60];
const COSTS = [
  { value: "", label: "不限" },
  { value: "any", label: "有费用" },
  { value: "none", label: "未计费" }
];

// 筛选区展开与否、「再显示」到了第几条放模块里：改筛选会重画整页（新 root），看完详情后退回来也要接着原来的位置
let filterOpen = false;
let shownFor = { key: "", n: PAGE };

// ---------------------------------------------------------------- 筛选参数（URL → 校验过的值）

function readFilters(q) {
  const text = (q.get("q") || "").trim().slice(0, 60);
  const type = api.oneOf(q.get("type"), ["AC", "DC"], "");
  const geos = api.intList(q.get("geofence"));
  const dur = api.int(q.get("dur"), { min: 0, max: 99999, fallback: 0 });
  // 面板的 cost 变量是「费用 ≥ N」（不填就不筛）；另外加了「有费用 / 未计费」两档，找没填费用的充电方便
  const costRaw = q.get("cost") || "";
  const costNum = api.float(costRaw, null);
  const cost = costRaw === "any" || costRaw === "none" ? costRaw : costNum != null && costNum >= 0 ? costNum : "";
  const view = api.oneOf(q.get("view"), ["table"], "list");
  return { text, type, geos, dur, cost, view };
}

function filterSummary(f, geofences) {
  const out = [];
  if (f.text) out.push(`含「${f.text}」`);
  if (f.type) out.push(f.type === "AC" ? "交流慢充" : "直流快充");
  if (f.geos.length) {
    const names = f.geos.map((id) => (geofences.find((g) => g.id === id) || {}).name).filter(Boolean);
    if (names.length) out.push(names.join("、"));
  }
  if (f.dur) out.push(`≥ ${fmt.duration(f.dur)}`);
  if (f.cost === "any") out.push("有费用");
  else if (f.cost === "none") out.push("未计费");
  else if (f.cost !== "") out.push(`费用 ≥ ${fmt.money(f.cost, f.cost % 1 ? 2 : 0)}`);
  return out;
}

const CLEAR = { q: null, type: null, geofence: null, dur: null, cost: null };

// ---------------------------------------------------------------- SQL

// 和面板的表格一样：先按时间、围栏、充入 > 0 取出来，算和上一次充电之间的里程差（里程表倒退的是坏数据，面板把它去掉），
// 再按时长、费用、类型、地点筛。没结束的充电也放进去算里程差（面板也是），最后再去掉
function listSql(f) {
  const where = ["$__timeFilter(cp.start_date)"];
  if (f.geos.length) where.push(`cp.geofence_id = any(array[${f.geos.join(",")}]::int[])`);
  const outer = ["(odo_delta >= 0 or odo_delta is null)", "not incomplete", `duration_min >= ${f.dur}`];
  if (f.type) outer.push(`charge_type = ${api.lit(f.type)}`);
  if (f.cost === "any") outer.push("cost is not null");
  else if (f.cost === "none") outer.push("cost is null");
  else if (typeof f.cost === "number") outer.push(`cost >= ${f.cost}`);
  // 面板只搜地址（「名称 / 路名 门牌, 城市」）；这里是它的超集：面板那种写法照样能搜到，另外还搜
  // 围栏名、街道、区县，以及列表上显示的短地名（「泉城路188号」，路名门牌之间没有空格），照着列表上看到的字搜也能找到
  if (f.text) {
    const pat = api.like(f.text);
    outer.push(`id in (
      select cp.id from charging_processes cp
      left join addresses a on a.id = cp.address_id
      left join geofences g on g.id = cp.geofence_id
      where cp.car_id = $car_id and (
        concat_ws(', ', coalesce(a.name, nullif(concat_ws(' ', a.road, a.house_number), '')), a.city) ilike ${pat}
        or concat_ws(' ', g.name, a.name, a.road, a.house_number, concat(a.road, a.house_number), a.neighbourhood, a.county, a.city) ilike ${pat}))`);
  }
  return `with items as (${CHARGE_ITEM_SQL(where.join(" and "), { incomplete: true })}),
d as (select *, odometer - lag(odometer) over (order by start_date) as odo_delta from items)
select * from d
where ${outer.join("\n  and ")}
order by start_date desc`;
}

// ---------------------------------------------------------------- 汇总

function summarize(rows) {
  const s = { n: rows.length, added: 0, used: 0, cost: 0, costN: 0, costKwh: 0, dur: 0, AC: { cost: 0, kwh: 0 }, DC: { cost: 0, kwh: 0 } };
  for (const r of rows) {
    s.added += +r.energy_added || 0;
    s.used += +r.energy_used || 0;
    s.dur += +r.duration_min || 0;
    if (r.cost != null) {
      s.cost += +r.cost;
      s.costN++;
      s.costKwh += +r.energy_used || 0;
      s[r.charge_type].cost += +r.cost;
      s[r.charge_type].kwh += +r.energy_used || 0;
    }
  }
  // 库里都是两位小数，累加出来的 70.94999… 先按分取整，不然显示成 70.9 而不是 71.0
  for (const k of ["added", "used", "cost", "costKwh"]) s[k] = Math.round(s[k] * 100) / 100;
  // 平均单价只算记了费用的那几次（没填费用不等于免费，算进去会把单价拉低）
  s.price = s.costKwh > 0 ? s.cost / s.costKwh : null;
  s.priceAC = s.AC.kwh > 0 ? s.AC.cost / s.AC.kwh : null;
  s.priceDC = s.DC.kwh > 0 ? s.DC.cost / s.DC.kwh : null;
  return s;
}

// 格子里的小字最多两行、尽量在空格处折：数字和单位、「慢充」和它的单价之间用不换行空格，只在它们之间的空格处折
const nb = (text) => text.replace(/ /g, " ");

function statsHtml(s) {
  let priceSub = "按从电网取的电量算";
  if (s.priceAC != null && s.priceDC != null) priceSub = `${nb(`慢充 ${fmt.money(s.priceAC)}`)} · ${nb(`快充 ${fmt.money(s.priceDC)}`)}`;
  return ui.stats(
    [
      { label: "充电次数", icon: "ev-station", value: s.n, unit: "次", sub: `平均每次 ${nb(fmt.duration(s.dur / s.n))}` },
      { label: "充入电量", icon: "battery-charging-high", value: fmt.num(s.added, 1), unit: "kWh", sub: `从电网取 ${nb(fmt.kwh(s.used, 1))}` },
      {
        label: "花费",
        icon: "cash-multiple",
        value: s.costN ? fmt.money(s.cost) : null,
        sub: s.costN < s.n ? `${s.n - s.costN} 次未计费` : `平均每次 ${fmt.money(s.cost / s.n)}`
      },
      { label: "平均单价", icon: "tag-outline", value: s.price != null ? fmt.money(s.price) : null, unit: "/度", sub: s.price != null ? priceSub : null }
    ],
    { cols: 4 }
  );
}

// ---------------------------------------------------------------- 筛选条（ui.filterBar，和行程列表同一个样子）

function filterBar(f, geofences, ctx) {
  const costPreset = f.cost === "any" || f.cost === "none" ? f.cost : f.cost === "" ? "" : null;
  const durs = DURATIONS.map((v) => ({ value: String(v), label: v ? fmt.duration(v) : "不限" })).concat(
    DURATIONS.includes(f.dur) ? [] : [{ value: String(f.dur), label: fmt.duration(f.dur) }]
  );
  return ui.filterBar({
    summary: filterSummary(f, geofences),
    hint: "按地点、类型、费用等筛选",
    open: filterOpen,
    onToggle: (o) => (filterOpen = o),
    onClear: () => ctx.setQuery(CLEAR),
    autofocus: true,
    body: html`<form class="tm-field" role="search" data-search>
        <label for="pg-charges-q">地点</label>
        <span class="tm-search">
          ${ui.icon("magnify")}
          <input class="tm-input" id="pg-charges-q" type="search" name="q" value="${f.text}" maxlength="60" placeholder="地址或收藏点包含的文字" enterkeyhint="search" autocomplete="off">
        </span>
      </form>
      <div class="tm-field">
        <span>类型</span>
        ${ui.segmented("type", TYPES, f.type, { label: "充电类型" })}
      </div>
      ${geofences.length
        ? html`<div class="tm-field">
            <span>收藏点</span>
            <div class="tm-flex" role="group" aria-label="在这些收藏点充的电">
              <button type="button" class="tm-chip" data-geo="" aria-pressed="${f.geos.length ? "false" : "true"}">全部</button>
              ${geofences.map(
                (g) => html`<button type="button" class="tm-chip" data-geo="${g.id}" aria-pressed="${f.geos.includes(g.id) ? "true" : "false"}">${g.name}</button>`
              )}
            </div>
          </div>`
        : ""}
      <div class="tm-field">
        <span>最短时长</span>
        ${ui.segmented("dur", durs, String(f.dur), { label: "最短时长" })}
      </div>
      <div class="tm-field">
        <span>费用</span>
        <div class="pg-charges-cost">
          ${ui.segmented("cost", COSTS, costPreset, { label: "费用" })}
          <label class="pg-charges-min">
            <span>不低于 ¥</span>
            <input class="tm-input" type="number" inputmode="decimal" min="0" step="any" value="${typeof f.cost === "number" ? f.cost : ""}" placeholder="—" data-cost aria-label="费用不低于（元）">
          </label>
        </div>
      </div>`
  });
}

// 筛选面板里的控件、空状态里的「清除筛选」（展开 / 收起、筛选条上的「清除」核心已处理）
function bindFilters(ctx, f) {
  const root = ctx.root;

  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) ctx.setQuery(CLEAR);
    const chip = e.target.closest("[data-geo]");
    if (chip) {
      const id = chip.dataset.geo ? +chip.dataset.geo : null;
      const next = id == null ? [] : f.geos.includes(id) ? f.geos.filter((x) => x !== id) : [...f.geos, id];
      ctx.setQuery({ geofence: next.length ? next.join(",") : null });
    }
  });

  // 这段时间一次充电都没有（也没加筛选）时不画筛选条
  const form = root.querySelector("[data-search]");
  if (!form) return;

  ui.onSegment(root, "type", (v) => ctx.setQuery({ type: v || null }));
  ui.onSegment(root, "dur", (v) => ctx.setQuery({ dur: +v > 0 ? v : null }));
  ui.onSegment(root, "cost", (v) => ctx.setQuery({ cost: v || null }));

  // 搜索：回车（手机键盘上的「搜索」）或清空时提交，不边打边查 —— 每查一次整页重画，输入框会丢焦点
  const input = form.querySelector("input");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    input.blur();
    ctx.setQuery({ q: input.value.trim().slice(0, 60) || null });
  });
  input.addEventListener("search", () => {
    if (!input.value && f.text) ctx.setQuery({ q: null });
  });

  const costInput = root.querySelector("[data-cost]");
  costInput.addEventListener("change", () => {
    const v = api.float(costInput.value.trim(), null);
    ctx.setQuery({ cost: v != null && v >= 0 ? String(v) : null });
  });
}

// ---------------------------------------------------------------- 充电量柱状图（慢充 / 快充叠在一起）

// 和行程页的里程图一样：横轴画满整个范围（「全部」从第一次充电开始），前面没充电的日子也看得出来；
// 跨度短按天，长了按周 / 按月合并（chart.bucketKind），不然全部范围几百根柱子挤成一团
function chartSpan(rows, rng) {
  const first = chart.bucketOf(rows[rows.length - 1].start_date, "day");
  const last = chart.bucketEnd(rows[0].start_date, "day");
  return { from: rng.kind === "all" ? first : rng.from, to: Math.max(rng.to, last) };
}

// 都在同一天时一根柱子没什么好看的（和行程页一样，至少两天才画）
function chartHtml(rows, s, kind) {
  if (new Set(rows.map((r) => chart.bucketOf(r.start_date, "day"))).size < 2) return "";
  const title = { day: "每天充电量", week: "每周充电量", month: "每月充电量" }[kind];
  return ui.card(
    html`<div class="tm-chart-head"><span>${title}</span><span class="tm-num">${fmt.kwh(s.added, 1)}</span></div>
      ${ui.chartBox("pg-charges-chart", { height: 170, heightMobile: 150, label: "充电量柱状图" })}`
  );
}

async function drawChart(ctx, rows, span, kind) {
  const el = ctx.root.querySelector("#pg-charges-chart");
  if (!el) return;
  const sums = new Map();
  for (const r of rows) {
    const k = chart.bucketOf(r.start_date, kind);
    const b = sums.get(k) || { AC: 0, DC: 0, n: 0, cost: null };
    b[r.charge_type] += +r.energy_added || 0;
    b.n++;
    if (r.cost != null) b.cost = Math.round(((b.cost || 0) + +r.cost) * 100) / 100;
    sums.set(k, b);
  }
  // 两条系列用同一组时间点（没有的记 0），叠加才对得上；柱子画在这一天 / 周 / 月的正中间
  const keys = [...sums.keys()].sort((a, b) => a - b);
  const hasAC = rows.some((r) => r.charge_type === "AC");
  const hasDC = rows.some((r) => r.charge_type === "DC");
  const width = kind === "day" ? 12 : 18;
  const data = (t) => keys.map((k) => [chart.bucketMid(k, kind), +sums.get(k)[t].toFixed(2), k]);
  await chart.create(el, {
    xAxis: chart.bucketAxis(kind, span.from, span.to),
    yAxis: chart.valueAxis({ splitNumber: 3 }),
    tooltip: chart.tooltip((ps) => {
      const list = Array.isArray(ps) ? ps : [ps];
      const k = list[0] && list[0].value[2];
      const b = sums.get(k);
      if (!b) return "";
      return chart.tipHtml(chart.bucketTitle(k, kind), [
        hasAC && b.AC > 0 ? { color: chart.color("c4"), name: "慢充", value: fmt.kwh(b.AC, 1) } : null,
        hasDC && b.DC > 0 ? { color: chart.color("c2"), name: "快充", value: fmt.kwh(b.DC, 1) } : null,
        { name: "次数", value: `${b.n} 次` },
        b.cost != null ? { name: "花费", value: fmt.money(b.cost) } : null
      ]);
    }),
    // 时间轴上柱宽按相邻两个数据点的最小间隔算，一段时间里充电次数少时会细成一条线：给个最小宽度
    series: [
      hasAC && { ...chart.bars("慢充", data("AC"), { color: "c4", stack: "e", width }), barMinWidth: 3 },
      hasDC && { ...chart.bars("快充", data("DC"), { color: "c2", stack: "e", width }), barMinWidth: 3 }
    ].filter(Boolean)
  });
}

// ---------------------------------------------------------------- 正在充电 / 未完成的充电（不看时间范围和筛选）

// 没有结束时间的充电：最后一条记录还很新的是正在充（绿色），很久没有新记录的是 TeslaMate 中途停过（琥珀色，要手动修）
function openSections(rows, ctx) {
  const live = rows.filter((r) => chargeState(r) === "charging");
  const broken = rows.filter((r) => chargeState(r) !== "charging");
  return html`${live.length
    ? ui.section("正在充电", ui.card(ui.list(live.map((r) => chargeItem(r, ctx))), { pad: false, cls: "pg-charges-live" }), {
        sub: "还没结束，不计入下面的统计"
      })
    : ""}${broken.length
    ? ui.section(
        "未完成的充电",
        html`${ui.card(ui.list(broken.map((r) => chargeItem(r, ctx))), { pad: false, cls: "pg-charges-incomplete" })}
          <p class="tm-note pg-charges-incomplete-note">TeslaMate 没有记录到${broken.length > 1 ? "这几次" : "这次"}充电的结束（当时可能停止了运行），所以不计入统计。
            官方文档里有<a href="${FIX_DOC}" target="_blank" rel="noopener">手动修复数据</a>的方法。</p>`,
        { sub: `${broken.length} 次，不受时间范围和筛选影响` }
      )
    : ""}`;
}

// ---------------------------------------------------------------- 列表

// 组头用当天的完整合计（totals 是按全部行算的）：「再显示」的分界落在某一天中间时，那天只画出一部分行，合计照样是全天的
function dayGroups(rows, totals, ctx) {
  return groupByDay(rows).map((g) => {
    const t = totals.get(g.day) || g;
    return ui.dayGroup(
      g.label,
      `${t.count > 1 ? `${t.count} 次 · ` : ""}${fmt.kwh(t.energy, 1)}${t.cost != null ? ` · ${fmt.money(t.cost)}` : ""}`,
      ui.card(ui.list(g.rows.map((r) => chargeItem(r, ctx, { date: false }))), { pad: false }),
      { key: g.key }
    );
  });
}

// 表格：面板表格的全部列（手机上每行变一张小卡片）。单位写在表头里（桌面上表头可以折成两行），格子里只放数字，
// 这样 15 列在桌面的内容区里放得下（charges.css 里收窄了格子的留白），不用横着滚才看到最后几列。
// 每行是一次充电，电量和面板的表格一样保留两位小数（和详情页一致）
function table(rows, ctx) {
  const u = fmt.unit;
  return ui.card(
    ui.table({
      columns: [
        { key: "start_date", label: "时间", primary: true, fmt: (v) => fmt.dateTime(v) },
        { key: "place", label: "地点", wrap: true, fmt: (v) => v || UNKNOWN_PLACE },
        { key: "charge_type", label: "类型", align: "center", fmt: (v, r) => ui.pill(chargeKind(r).label, chargeKind(r).tone) },
        { key: "duration_min", label: "时长", align: "right", fmt: (v) => fmt.duration(v) },
        { key: "energy_added", label: "充入 kWh", align: "right", fmt: (v) => fmt.num(v, 2) },
        { key: "energy_used", label: "用电 kWh", align: "right", fmt: (v) => fmt.num(v, 2) },
        { key: "eff", label: "效率", align: "right", fmt: (v, r) => (r.energy_used > 0 ? fmt.pct((r.energy_added / r.energy_used) * 100, 1) : null) },
        { key: "cost", label: "费用", align: "right", fmt: (v) => (v != null ? fmt.money(v) : "未计费") },
        { key: "cost_per_kwh", label: "元⁠/⁠度", align: "right", fmt: (v) => (v != null ? fmt.num(v, 2) : null) },
        { key: "soc", label: "电量", align: "right", fmt: (v, r) => (r.start_soc != null ? `${r.start_soc}→${r.end_soc}%` : null) },
        { key: "range_added", label: `续航增加 ${u.len}`, align: "right", fmt: (v) => (v != null ? (v >= 0 ? "+" : "") + fmt.num(v) : null) },
        { key: "power_avg", label: "平均功率 kW", align: "right", fmt: (v) => fmt.num(v, 1) },
        {
          key: "rate",
          label: `充电速度 ${u.speed}`,
          align: "right",
          fmt: (v, r) => (r.range_added != null && r.duration_min > 0 ? fmt.num((r.range_added * 60) / r.duration_min) : null)
        },
        { key: "outside_temp", label: `气温 ${u.temp}`, align: "right", fmt: (v) => fmt.num(v, 1) },
        { key: "odometer", label: `里程表 ${u.len}`, align: "right", fmt: (v) => fmt.num(v) }
      ],
      rows,
      dense: true,
      rowHref: (r) => ctx.href(`/stats/charges/${r.id}`)
    }),
    // pager 追加下一页时把行并进这张表（tbody），不另起一张
    { pad: false, attrs: { "data-tm-append": "table" } }
  );
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  ctx.root.classList.add("pg-charges");
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "list"], { height: 150 }));
  const f = readFilters(ctx.query);

  const d = await api.batch(
    {
      rows: listSql(f),
      // 面板的「Incomplete Charges」不看时间范围：没结束的充电是要修的数据，什么时候的都列出来
      incomplete: CHARGE_ITEM_SQL("cp.end_date is null", { incomplete: true, empty: true }),
      geofences: "select id, name from geofences order by name"
    },
    { signal: ctx.signal }
  );

  // 页头「⋯ → 在 Grafana 中打开」带上同样的筛选（geofence 是多选，数组会写成多个 var-geofence）
  ctx.setGrafanaVars({
    "var-charge_type": f.type || null,
    "var-location": f.text || null,
    "var-min_duration_min": f.dur || null,
    "var-cost": typeof f.cost === "number" && Number.isInteger(f.cost) ? f.cost : null,
    "var-geofence": f.geos
  });

  const rows = d.rows;
  const active = filterSummary(f, d.geofences).length > 0;
  const s = rows.length ? summarize(rows) : null;
  const span = rows.length ? chartSpan(rows, ctx.range) : null;
  const kind = span ? chart.bucketKind(span.from, span.to) : null;

  // 布局和行程列表一样（.tm-list-layout）：手机、平板一列；桌面左栏放筛选、汇总、柱状图，右栏是列表。
  // 表格视图有 15 列，要整个内容区的宽度，这时还是一列（.is-wide）
  ui.render(
    ctx.root,
    rows.length
      ? html`<div class="tm-list-layout${f.view === "table" ? " is-wide" : ""}">
          <div class="tm-list-aside">
            ${filterBar(f, d.geofences, ctx)}
            ${statsHtml(s)}
            ${chartHtml(rows, s, kind)}
          </div>
          <div class="tm-list-main">
            ${openSections(d.incomplete, ctx)}
            ${ui.section(`${fmt.int(rows.length)} 次充电`, html`<div id="pg-charges-list"></div>`, {
              action: ui.segmented("view", [{ value: "list", label: "按天" }, { value: "table", label: "表格" }], f.view, { label: "显示方式" })
            })}
          </div>
        </div>`
      : html`${active ? filterBar(f, d.geofences, ctx) : ""}
          ${ui.card(
            active
              ? ui.empty("换个条件试试，或者清除筛选。", {
                  icon: "filter-variant",
                  title: "没有符合条件的充电",
                  action: ui.button("清除筛选", { kind: "soft", attrs: { "data-clear": "" } })
                })
              : ui.empty(`${ctx.range.label}没有充电记录。`, {
                  icon: "ev-station",
                  title: "没有充电",
                  action: ctx.range.key !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/charges", { r: "all" }) }) : null
                })
          )}
          ${openSections(d.incomplete, ctx)}`
  );

  bindFilters(ctx, f);
  if (!rows.length) return;
  ui.onSegment(ctx.root, "view", (v) => ctx.setQuery({ view: v === "table" ? "table" : null }));

  // ---- 列表：先画 50 条，「再显示」每次加 50 条（数据已经全在手里：汇总要用全部行）。
  // 看完详情退回来时接着原来显示到的位置（第一段直接画 n 条）
  const key = location.pathname + location.search;
  const first = shownFor.key === key ? Math.min(shownFor.n, rows.length) : PAGE;
  shownFor = { key, n: first };
  const dayTotals = new Map(groupByDay(rows).map((g) => [g.day, g]));
  const pager = ui.pager(ctx.root.querySelector("#pg-charges-list"), {
    total: rows.length,
    page: PAGE,
    noun: "次充电",
    load: (offset) => {
      const n = offset === 0 ? first : PAGE;
      const part = rows.slice(offset, offset + n);
      shownFor = { key, n: offset + part.length };
      return { html: f.view === "table" ? table(part, ctx) : html`${dayGroups(part, dayTotals, ctx)}`, count: part.length };
    }
  });

  await Promise.all([pager.ready, drawChart(ctx, rows, span, kind)]);
}
