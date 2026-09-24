// 行程列表（对应 Grafana「Drives」面板 Y8upc6ZRk）：
// 顶部汇总 = 面板的「Summary of this period」，列表 = 面板的「Drive」表格（按天分组），
// 「未完成的行程」= 面板的「Incomplete Drives」。筛选对应面板的 location / min_dist / geofence 变量。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import { DRIVE_ITEM_SQL, driveItem, groupByDay, lenText } from "./_drive-item.js";
import { placeSql } from "./_shared.js";

export const title = "行程";
export const range = { default: "90d" };
export const css = true;

// 一次取 50 条，「加载更多」再往后翻：全部范围可能有几千次行程，一次都画出来手机会卡
const PAGE = 50;
const DISTS = [0, 1, 5, 10, 50];
const FIX_DOC = "https://docs.teslamate.org/docs/maintenance/manually_fixing_data";
const INCOMPLETE_MAX = 20;

// ---------------------------------------------------------------- 筛选参数（URL → 校验过的值）

function readFilters(q) {
  const text = (q.get("q") || "").trim().slice(0, 60);
  const dist = Math.max(0, Math.min(10000, api.float(q.get("dist"), 0)));
  const geos = api.intList(q.get("geofence"), { min: 1 });
  return { text, dist, geos };
}

// 地点搜索和面板一样匹配完整地址（围栏名，或「地名 / 路名 门牌, 城市」，写法照抄面板），
// 另外也匹配列表里显示的短地名 —— 用户照着列表上看到的字搜（「百脉泉街8号」），得能搜到
const FULL = (g, a) =>
  `COALESCE(${g}.name, CONCAT_WS(', ', COALESCE(${a}.name, nullif(CONCAT_WS(' ', ${a}.road, ${a}.house_number), '')), ${a}.city))`;

// WHERE 片段（表别名和 _drive-item.js 一致：d 行程、sa/ea 地址、sg/eg 围栏）
function filterWhere(f) {
  const parts = ["$__timeFilter(d.start_date)"];
  if (f.dist > 0) parts.push(`convert_km(d.distance::numeric, '$length_unit') >= ${f.dist}`);
  if (f.geos.length) parts.push(`(d.start_geofence_id = any(array[${f.geos.join(",")}]) or d.end_geofence_id = any(array[${f.geos.join(",")}]))`);
  if (f.text) {
    // api.like：「包含」匹配，% _ \ 按字面；十六进制编码，前端变量替换和 Grafana 的宏展开都碰不到用户的字
    const like = api.like(f.text);
    parts.push(
      `(${FULL("sg", "sa")} ilike ${like} or ${FULL("eg", "ea")} ilike ${like} or ${placeSql("sg", "sa")} ilike ${like} or ${placeSql("eg", "ea")} ilike ${like})`
    );
  }
  return parts.join(" and ");
}

const FROM = `from drives d
join cars c on c.id = d.car_id
left join addresses sa on sa.id = d.start_address_id
left join addresses ea on ea.id = d.end_address_id
left join geofences sg on sg.id = d.start_geofence_id
left join geofences eg on eg.id = d.end_geofence_id`;

// 汇总和面板一样：里程、时长对所有行求和；耗电 = 续航差 × 车辆能效（有续航读数的才算）；平均能耗 = 总耗电 ÷ 总里程
const SUM_SQL = (where) => `select
  count(*) as n,
  sum(convert_km(d.distance::numeric, '$length_unit')) as distance,
  max(convert_km(d.distance::numeric, '$length_unit')) as distance_max,
  sum(d.duration_min) as duration,
  sum((d.start_\${preferred_range}_range_km - d.end_\${preferred_range}_range_km) * c.efficiency) as energy,
  max(convert_km(d.speed_max::numeric, '$length_unit')) as speed_max
${FROM}
where d.car_id = $car_id and d.end_date is not null and ${where}`;

// 每天的合计：组头的「3 次 · 24.5 km」和上面的柱状图都用它（列表是分页取的，不能拿已取到的行去加）
const DAILY_SQL = (where) => `select
  date_trunc('day', timezone('UTC', d.start_date), '$__timezone') as day,
  count(*) as n,
  sum(convert_km(d.distance::numeric, '$length_unit')) as distance,
  sum(d.duration_min) as duration
${FROM}
where d.car_id = $car_id and d.end_date is not null and ${where}
group by 1
order by 1`;

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const f = readFilters(ctx.query);
  const active = !!(f.text || f.dist > 0 || f.geos.length);
  const where = filterWhere(f);

  ctx.setGrafanaVars({
    "var-location": f.text || null,
    "var-min_dist": f.dist > 0 ? f.dist : null,
    // 多选：链接里写成多个 var-geofence（空数组就不带，面板默认是全部）
    "var-geofence": f.geos
  });

  ui.render(ctx.root, ui.skeleton(["stats", "list"]));

  const d = await api.batch(
    {
      sum: SUM_SQL(where),
      daily: DAILY_SQL(where),
      list: DRIVE_ITEM_SQL(where, { limit: PAGE }),
      // 和面板一样不限时间：没有结束的行程哪天都可能有，放在列表最上面提醒
      incomplete: DRIVE_ITEM_SQL("d.end_date is null", { incomplete: true, limit: INCOMPLETE_MAX }),
      // 列表只列最近几条，次数单独数（面板的表格是分页列出全部）
      incompleteN: "select count(*) as n from drives where car_id = $car_id and end_date is null",
      geofences: "select id, name from geofences order by name, id"
    },
    { signal: ctx.signal }
  );

  const s = d.sum[0] || {};
  const total = s.n || 0;
  const geofences = d.geofences;
  const dayTotals = new Map(d.daily.map((r) => [r.day, r]));
  const incompleteN = d.incompleteN[0] ? d.incompleteN[0].n : d.incomplete.length;
  const bar = filterBar(ctx, f, active, geofences);

  ui.render(
    ctx.root,
    html`
      ${total
        ? html`<div class="tm-list-layout">
            <div class="tm-list-aside">
              ${bar}
              ${summaryStats(s, total)}
              ${d.daily.length > 1
                ? ui.card(html`<div class="tm-chart-head"><span>${chartTitle(d.daily, ctx.range)}</span><span class="tm-num">${lenText(s.distance)}</span></div>${ui.chartBox("pg-drives-chart", { height: 170, heightMobile: 150, label: "里程柱状图" })}`)
                : ""}
            </div>
            <div class="tm-list-main">
              ${incompleteSection(d.incomplete, incompleteN, ctx)}
              ${ui.section(`${fmt.int(total)} 次行程`, html`<div id="pg-drives-days"></div>`)}
            </div>
          </div>`
        : html`${active ? bar : ""}${ui.card(
            active
              ? ui.empty("换个条件试试，或者清除筛选。", {
                  icon: "filter-variant",
                  title: "没有符合条件的行程",
                  action: ui.button("清除筛选", { kind: "soft", attrs: { "data-clear": "" } })
                })
              : ui.empty(`${ctx.range.label}没有记录到行程。`, {
                  icon: "road-variant",
                  title: "没有行程",
                  action: ctx.range.key !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/drives", { r: "all" }) }) : null
                })
          )}
          ${incompleteSection(d.incomplete, incompleteN, ctx)}`}
    `
  );

  bindFilters(ctx, f);
  if (!total) return;

  // ---- 列表（按天分组，「再显示 50 次」往下追加；同一天跨页时 pager 把行并进已有的组）
  const seen = new Set();
  const pager = ui.pager(ctx.root.querySelector("#pg-drives-days"), {
    total,
    page: PAGE,
    noun: "次行程",
    load: async (offset) => {
      const rows = offset === 0 ? d.list : await api.sql(DRIVE_ITEM_SQL(where, { limit: PAGE, offset }), { signal: ctx.signal });
      // 翻页期间来了新行程时 offset 会错一位，上一页最后一条会再出现一次：按 id 去重（count 仍按取到的条数，offset 才对得上）
      const fresh = rows.filter((r) => !seen.has(r.id));
      for (const r of fresh) seen.add(r.id);
      return { html: groupByDay(fresh).map((g) => dayGroup(g, dayTotals.get(g.day), ctx)), count: rows.length };
    }
  });

  // ---- 柱状图（ECharts 按需加载；列表先画出来，图晚一点没关系）
  await Promise.all([pager.ready, d.daily.length > 1 ? drawChart(ctx, d.daily, ctx.range) : null]);
}

function summaryStats(s, total) {
  const cons = s.distance > 0 && s.energy != null ? (s.energy / s.distance) * 1000 : null;
  // 国内习惯说「每百公里几度电」，km 时顺便换算一下
  const per100 = cons != null && fmt.unit.len === "km" ? `${fmt.num(cons / 10, 1)} kWh/百公里` : null;
  const dist = +s.distance || 0;
  return ui.stats(
    [
      { label: "行程", icon: "map-marker-path", value: total, unit: "次", sub: `平均每次 ${lenText(dist / total)}` },
      { label: "里程", icon: "road-variant", value: fmt.num(dist, dist >= 99.95 ? 0 : 1), unit: fmt.unit.len, sub: `最远一次 ${lenText(s.distance_max)}` },
      {
        label: "驾驶时长",
        icon: "clock-outline",
        // 合计时长用小时数（「54.5 小时」比「2天6小时」好比较）
        ...(s.duration >= 60 ? { value: fmt.num(s.duration / 60, 1), unit: "小时" } : { value: s.duration, unit: "分钟" }),
        sub: s.duration > 0 ? `平均 ${fmt.speed(dist / (s.duration / 60))}` : null
      },
      { label: "耗电（净）", icon: "lightning-bolt", value: fmt.num(s.energy, 1), unit: "kWh", sub: "按续航减少估算" },
      { label: "平均能耗（净）", icon: "leaf", value: cons, unit: fmt.unit.cons, sub: per100 },
      { label: "最高速度", icon: "speedometer", value: s.speed_max, unit: fmt.unit.speed }
    ],
    { cols: 3 }
  );
}

// ---------------------------------------------------------------- 筛选条

// 展开与否放模块里：改筛选会重画整页（新 root），不然每改一次就收起来
let filterOpen = false;

function filterSummary(f, geofences) {
  const out = [];
  if (f.text) out.push(`含「${f.text}」`);
  if (f.dist > 0) out.push(`≥ ${fmt.len(f.dist, f.dist % 1 ? 1 : 0)}`);
  if (f.geos.length) {
    const names = f.geos.map((id) => (geofences.find((g) => g.id === id) || {}).name).filter(Boolean);
    out.push(names.length ? names.join("、") : `${f.geos.length} 个收藏点`);
  }
  return out;
}

function filterBar(ctx, f, active, geofences) {
  const distOpts = DISTS.map((v) => ({ value: String(v), label: v ? `≥${v}` : "不限" }));
  // URL 里手写的距离不在档位里时也列出来，不然看不出现在按什么筛的
  if (!DISTS.includes(f.dist)) distOpts.push({ value: String(f.dist), label: `≥${fmt.num(f.dist, 1)}` });
  return ui.filterBar({
    summary: filterSummary(f, geofences),
    active,
    hint: "按地点、距离、收藏点筛选",
    open: filterOpen,
    onToggle: (o) => (filterOpen = o),
    onClear: () => ctx.setQuery({ q: null, dist: null, geofence: null }),
    autofocus: true,
    body: html`
      <form role="search" data-search>
        <label class="tm-field">
          <span>地点</span>
          <span class="tm-search">
            ${ui.icon("magnify")}
            <input class="tm-input" type="search" name="q" value="${f.text}" maxlength="60" placeholder="起点或终点包含的文字" enterkeyhint="search" autocomplete="off">
          </span>
        </label>
      </form>
      <div class="tm-field">
        <span>最短距离</span>
        ${ui.segmented("dist", distOpts, String(f.dist), { full: true, suffix: fmt.unit.len, label: "最短距离" })}
      </div>
      ${geofences.length
        ? html`<div class="tm-field">
            <span>收藏点</span>
            <div class="tm-flex" role="group" aria-label="起点或终点在这些收藏点">
              <button type="button" class="tm-chip" data-geo="" aria-pressed="${f.geos.length ? "false" : "true"}">全部</button>
              ${geofences.map(
                (g) => html`<button type="button" class="tm-chip" data-geo="${g.id}" aria-pressed="${f.geos.includes(g.id) ? "true" : "false"}">${g.name}</button>`
              )}
            </div>
            <span class="tm-note">起点或终点在所选收藏点的行程</span>
          </div>`
        : ""}`
  });
}

// 面板里的表单事件（展开 / 收起、「清除」由 ui.filterBar 处理）
function bindFilters(ctx, f) {
  const root = ctx.root;

  // 空状态的「清除筛选」、收藏点 chip：委托到 root 上
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) ctx.setQuery({ q: null, dist: null, geofence: null });
    const chip = e.target.closest("[data-geo]");
    if (chip) {
      const id = chip.dataset.geo ? +chip.dataset.geo : null;
      const next = id == null ? [] : f.geos.includes(id) ? f.geos.filter((x) => x !== id) : [...f.geos, id];
      ctx.setQuery({ geofence: next.length ? next.join(",") : null });
    }
  });

  ui.onSegment(root, "dist", (v) => ctx.setQuery({ dist: +v > 0 ? v : null }));

  // 搜索：回车（手机键盘上的「搜索」）或清空时提交，不边打边查 —— 每查一次整页重画，输入框会丢焦点
  const form = root.querySelector("form[data-search]");
  if (!form) return;
  const input = form.querySelector("input[name=q]");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    input.blur();
    ctx.setQuery({ q: input.value.trim() || null });
  });
  input.addEventListener("search", () => {
    if (!input.value && f.text) ctx.setQuery({ q: null });
  });
}

// ---------------------------------------------------------------- 未完成的行程

function incompleteSection(rows, n, ctx) {
  if (!rows.length) return "";
  return ui.section(
    "未完成的行程",
    html`${ui.card(ui.list(rows.map((r) => driveItem(r, ctx))), { pad: false, cls: "pg-drives-incomplete" })}
      <p class="tm-note pg-drives-incomplete-note">TeslaMate 在这些行程中途停止过，没有结束记录，所以不计入里程和耗电。
        可以照官方文档<a href="${FIX_DOC}" target="_blank" rel="noopener">手动修复数据</a>。</p>`,
    { sub: `${n} 次${n > rows.length ? `（这里列出最近 ${rows.length} 次）` : ""}，不受时间范围和筛选影响` }
  );
}

// ---------------------------------------------------------------- 按天分组的列表

function dayGroup(g, tot, ctx) {
  // 组头用当天的完整合计（分页时这一天可能只取到一部分；并组时保留第一次画的组头，所以一开始就得是全天的）
  const n = tot ? tot.n : g.count;
  const dist = tot ? tot.distance : g.distance;
  return ui.dayGroup(g.label, `${n} 次 · ${lenText(dist)}`, ui.card(ui.list(g.rows.map((r) => driveItem(r, ctx, { date: false }))), { pad: false }), {
    key: g.key
  });
}

// ---------------------------------------------------------------- 里程柱状图

const DAY = 86400e3;

// 横轴：「全部」从第一次行程开始，其它范围整段都画出来（前面没开车的日子也看得出来）
function chartSpan(daily, rng) {
  const from = rng.kind === "all" ? daily[0].day : rng.from;
  return { from, to: Math.max(rng.to, daily[daily.length - 1].day + DAY) };
}

// 天数少按天，长了按周 / 按月合并，不然全部范围几百根柱子挤成一团
function bucketKind(daily, rng) {
  const { from, to } = chartSpan(daily, rng);
  return chart.bucketKind(from, to);
}

function chartTitle(daily, rng) {
  return { day: "每天里程", week: "每周里程", month: "每月里程" }[bucketKind(daily, rng)];
}

async function drawChart(ctx, daily, rng) {
  const kind = bucketKind(daily, rng);
  const span = chartSpan(daily, rng);
  const sums = new Map();
  for (const r of daily) {
    const k = chart.bucketOf(r.day, kind);
    const cur = sums.get(k) || { dist: 0, n: 0 };
    cur.dist += +r.distance || 0;
    cur.n += r.n;
    sums.set(k, cur);
  }
  // 柱子画在桶的正中间，和坐标轴上的日期对齐；第 4 列留着桶的起点给提示框
  const data = [...sums].map(([k, v]) => [chart.bucketMid(k, kind), +v.dist.toFixed(1), v.n, k]);
  await chart.create(ctx.root.querySelector("#pg-drives-chart"), {
    xAxis: chart.bucketAxis(kind, span.from, span.to),
    yAxis: chart.valueAxis({ splitNumber: 3 }),
    tooltip: chart.tooltip((ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      return chart.tipHtml(chart.bucketTitle(p.value[3], kind), [
        { color: p.color, name: "里程", value: lenText(p.value[1]) },
        { name: "行程", value: `${p.value[2]} 次` }
      ]);
    }),
    series: [chart.bars("里程", data, { color: "c1", width: kind === "day" ? 14 : 18 })]
  });
}
