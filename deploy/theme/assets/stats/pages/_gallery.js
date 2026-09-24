// 组件样板页（/stats/_gallery，开发用，不出现在导航里；集成时删掉）。
// 所有数据都是写死 / 算出来的假数据，不查数据库。页面代理照着这里用组件。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import * as map from "../core/map.js";
import { ICONS } from "../core/icons.js";

export const title = "组件样板";
export const range = { default: "30d" };
export const css = false;

// 固定种子的伪随机数，截图每次一样
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DAY = 86400e3;
const today0 = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function socSeries() {
  const r = rng(7);
  const out = [];
  const usable = [];
  let soc = 80;
  const start = today0() - 6 * DAY;
  for (let t = start; t <= Date.now(); t += 30 * 60e3) {
    const h = new Date(t).getHours();
    if (h >= 23 || h < 6) soc = Math.min(90, soc + 2.6); // 夜里在家充电
    else if ((h >= 8 && h < 9) || (h >= 18 && h < 19)) soc -= 3 + r() * 3; // 通勤
    else soc -= 0.05;
    soc = Math.max(12, soc);
    out.push([t, +soc.toFixed(1)]);
    usable.push([t, +(soc - 1.5).toFixed(1)]);
  }
  return { out, usable };
}

function dailyKm() {
  const r = rng(3);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push([today0() - i * DAY, Math.round(18 + r() * 60 + (i % 7 === 1 ? 120 : 0))]);
  return days;
}

function scatter() {
  const r = rng(11);
  return Array.from({ length: 70 }, () => {
    const temp = -8 + r() * 42;
    const cons = 128 + Math.abs(temp - 21) * 2.3 + (r() - 0.5) * 30;
    return [+temp.toFixed(1), Math.round(cons)];
  });
}

function heat() {
  const r = rng(5);
  const data = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      let v = r() * 1.2;
      if (d < 5 && (h === 8 || h === 18)) v += 6 + r() * 3;
      if (d >= 5 && h >= 10 && h <= 16) v += 2 + r() * 3;
      data.push([h, d, Math.round(v)]);
    }
  }
  return data;
}

function states() {
  const t0 = today0();
  const H = 3600e3;
  const seg = (lane, a, b, color, name) => ({ lane, start: t0 + a * H, end: t0 + b * H, color, name });
  return [
    seg(0, 0, 6.5, "c3", "休眠"), seg(0, 6.5, 22, "c1", "在线"), seg(0, 22, 24, "c3", "休眠"),
    seg(1, 0, 5.5, "c4", "充电"), seg(1, 7.8, 8.6, "c1", "行驶"), seg(1, 12.2, 12.5, "c1", "行驶"),
    seg(1, 17.9, 18.8, "c1", "行驶"), seg(1, 19.5, 20.2, "c2", "超充"), seg(1, 8.6, 12.2, "c5", "停车"), seg(1, 12.5, 17.9, "c5", "停车")
  ];
}

// 济南经十路一带的一条假路线（WGS-84，画的时候会转成 GCJ-02）
const TRACK = [
  [36.6547, 116.9802], [36.6552, 116.9921], [36.6556, 117.0044], [36.6559, 117.0171], [36.6561, 117.0293],
  [36.6558, 117.0402], [36.6549, 117.0515], [36.6544, 117.0633], [36.6541, 117.0751], [36.6536, 117.0872],
  [36.6531, 117.0985], [36.6559, 117.1068], [36.6612, 117.1114], [36.6655, 117.1188], [36.6668, 117.1297]
];

function fakeRows() {
  return [
    { id: 1, start: Date.now() - 3 * 3600e3, from: "历下区经十路 12345 号", to: "高新区舜华路 2000 号", km: 12.4, min: 26, cons: 148, temp: 21.5 },
    { id: 2, start: Date.now() - 27 * 3600e3, from: "高新区舜华路 2000 号", to: "家", km: 12.9, min: 31, cons: 156, temp: 19.2 },
    { id: 3, start: Date.now() - 50 * 3600e3, from: "家", to: "济南西站 <b>不应该变粗</b>", km: 23.1, min: 38, cons: 139, temp: 24.8 },
    { id: 4, start: Date.now() - 6 * DAY, from: "泉城广场", to: "章丘区明水街道百脉泉公园东门停车场", km: 41.7, min: 55, cons: 171, temp: 8.3 }
  ];
}

export async function render(ctx) {
  const rows = fakeRows();
  const soc = socSeries();

  ui.render(
    ctx.root,
    html`
      ${ui.card(
        html`<p class="tm-small">这里是所有公共组件和图表的样子，数据都是假的。页头的范围选择器、⋯ 菜单也是外壳自带的。
          当前范围：<strong>${ctx.range.label}</strong>（${fmt.dateTime(ctx.range.from)} – ${fmt.dateTime(ctx.range.to)}，r=${ctx.range.key}）</p>`
      )}

      ${ui.section("统计数字宫格 ui.stats", ui.stats([
        { label: "总里程", value: fmt.num(12345.6, 0), unit: fmt.unit.len, sub: "近30天 +1,024 km" },
        { label: "平均能耗", value: 152, unit: fmt.unit.cons, sub: "比上月低 4%", tone: "green", icon: "leaf" },
        { label: "充电量", value: fmt.num(386.4, 1), unit: "kWh", sub: "23 次" },
        { label: "电费", value: fmt.money(214.5), sub: "每度 ¥0.56", tone: "amber" },
        { label: "没有数据", value: null, unit: "km", sub: "null 显示成 —" },
        { label: "很长很长很长的标签会省略号", value: "1,234,567.89", unit: "kWh", tone: "red" }
      ]))}

      ${ui.section(
        "列表 ui.list",
        ui.card(
          ui.list([
            { href: ctx.href("/stats/drives/1"), icon: "road-variant", title: "历下区经十路 → 高新区舜华路", sub: `${fmt.day(rows[0].start)} ${fmt.time(rows[0].start)} · ${fmt.duration(26)}`, value: fmt.len(12.4, 1), valueSub: fmt.cons(148) },
            { href: ctx.href("/stats/charges/1"), icon: "ev-station", tone: "green", title: "家", sub: `${fmt.day(Date.now() - DAY)} 23:10 · ${fmt.duration(372)}`, meta: html`${ui.pill("慢充", "green")}${ui.pill("AC 7kW")}`, value: fmt.kwh(42.8), valueSub: fmt.money(23.97) },
            { href: ctx.href("/stats/charges/2"), icon: "lightning-bolt", tone: "amber", title: "特斯拉超级充电站（济南高新万达）", sub: `${fmt.day(Date.now() - 3 * DAY)} 12:40 · ${fmt.duration(24)}`, meta: ui.pill("超充", "amber"), value: fmt.kwh(35.1), valueSub: fmt.money(52.65) },
            { icon: "update", tone: "violet", title: "2026.32.5 <script>（转义测试）", sub: "没有 href 的行不能点", value: "12天" }
          ], { more: { href: ctx.href("/stats/drives"), label: "查看全部行程" } }),
          { pad: false }
        ),
        { action: { href: ctx.href("/stats/drives"), label: "全部" } }
      )}

      ${ui.section(
        "表格 ui.table（手机上变卡片）",
        ui.card(
          ui.table({
            columns: [
              { key: "start", label: "时间", fmt: (v) => fmt.dateTime(v), primary: true },
              { key: "from", label: "出发", wrap: true },
              { key: "to", label: "到达", wrap: true },
              { key: "km", label: "距离", align: "right", fmt: (v) => fmt.len(v, 1) },
              { key: "min", label: "用时", align: "right", fmt: (v) => fmt.duration(v) },
              { key: "cons", label: "能耗", align: "right", fmt: (v) => fmt.cons(v) },
              { key: "temp", label: "气温", align: "right", fmt: (v) => fmt.temp(v), mobile: false }
            ],
            rows,
            rowHref: (r) => ctx.href(`/stats/drives/${r.id}`)
          }),
          { pad: false }
        )
      )}

      <div class="tm-grid-2">
        ${ui.section(
          "分段选择 ui.segmented",
          ui.card(html`<div class="tm-stack">
            ${ui.segmented("period", [{ value: "day", label: "按天" }, { value: "week", label: "按周" }, { value: "month", label: "按月" }, { value: "year", label: "按年" }], ctx.query.get("period") || "month")}
            <p class="tm-small tm-muted">选中：<strong id="g-period">${ctx.query.get("period") || "month"}</strong>（真实页面里用 ctx.setQuery 写进 URL）</p>
            ${ui.segmented("kind", ["全部", "快充", "慢充"], "全部", { full: true })}
          </div>`)
        )}
        ${ui.section(
          "标签、进度条 ui.pill / ui.bar",
          ui.card(html`<div class="tm-stack">
            <div class="tm-flex">${ui.pill("默认")}${ui.pill("蓝", "accent")}${ui.pill("快充", "amber", { icon: "lightning-bolt" })}${ui.pill("慢充", "green")}${ui.pill("失败", "red")}${ui.pill("紫", "violet")}${ui.pill("青", "cyan")}</div>
            ${[["家", 62, "accent"], ["公司", 18, "violet"], ["超充", 12, "amber"], ["其它", 8, "cyan"]].map(
              ([k, v, t]) => html`<div class="tm-stack" style="gap:4px"><div class="tm-between tm-small"><span class="tm-strong">${k}</span><span class="tm-num">${fmt.pct(v)}</span></div>${ui.bar(v, 62, t)}</div>`
            )}
          </div>`)
        )}
      </div>

      <div class="tm-grid-2">
        ${ui.section("键值对 ui.kv", ui.card(ui.kv([["开始", fmt.dateTime(rows[0].start)], ["结束", fmt.dateTime(rows[0].start + 26 * 60e3)], ["距离", fmt.len(12.4, 1)], ["能耗", fmt.cons(148)], ["出发地", rows[0].from], ["空值", null]])))}
        ${ui.section("按钮 ui.button / 弹出菜单 ui.openSheet", ui.card(html`<div class="tm-flex">
          ${ui.button("主要按钮", { kind: "primary", icon: "check" })}
          ${ui.button("浅色", { kind: "soft", icon: "refresh" })}
          ${ui.button("默认")}
          ${ui.button("文字按钮", { kind: "text" })}
          ${ui.button("小按钮", { small: true })}
          ${ui.button("打开菜单", { icon: "dots-horizontal", attrs: { id: "g-menu", "aria-haspopup": "menu" } })}
        </div>`))}
      </div>

      ${ui.section("图表：折线 + 面积（chart.line，时间轴）", ui.card(ui.chartBox("g-line", { height: 260, heightMobile: 220, label: "电量变化" })))}
      <div class="tm-grid-2">
        ${ui.section("柱状图（chart.bars，带数值）", ui.card(ui.chartBox("g-bar", { height: 240 })))}
        ${ui.section("饼图（环形）", ui.card(ui.chartBox("g-pie", { height: 240 })))}
      </div>
      <div class="tm-grid-2">
        ${ui.section("散点图", ui.card(ui.chartBox("g-scatter", { height: 260 })))}
        ${ui.section("热力图（星期 × 小时）", ui.card(ui.chartBox("g-heat", { height: 260 })))}
      </div>
      ${ui.section("状态时间线（custom series：chart.timelineSeries）", ui.card(ui.chartBox("g-states", { height: 150, heightMobile: 140 })))}

      ${ui.section(
        "地图：轨迹 + 起终点 + 充电桩（高德瓦片，WGS→GCJ）",
        ui.card(html`${ui.mapBox("g-map", { height: 340 })}
          <div class="tm-card is-pad" style="border:0;box-shadow:none;border-radius:0 0 var(--tm-r-lg) var(--tm-r-lg)">
            ${ui.kv([["路线", "经十路 → 舜华路（假数据）"], ["距离", fmt.len(15.2, 1)]])}
          </div>`, { pad: false })
      )}

      <div class="tm-grid-2">
        ${ui.section("空状态 ui.empty", ui.card(ui.empty("这段时间没有行程。", { icon: "road-variant", title: "没有数据" })))}
        ${ui.section("错误卡片 ui.error", ui.card(html`<div id="g-error">${ui.error(new Error("查询「drives」出错：db query error: ERROR: relation \"drivez\" does not exist (SQLSTATE 42P01)"), retryDemo)}</div>`))}
      </div>
      <div class="tm-grid-2">
        ${ui.section("网络错误", ui.card(ui.error(Object.assign(new Error("网络连接失败"), { network: true }), () => {})))}
        ${ui.section("登录过期（401）", ui.card(ui.error({ auth: true, status: 401 })))}
      </div>

      ${ui.section("骨架 ui.skeleton('stats' | 'list' | 'chart' | 'map' | 'kv')", html`<div class="tm-stack">
        ${ui.skeleton("stats")}
        <div class="tm-grid-2">${ui.skeleton("list", { rows: 3 })}${ui.skeleton("chart", { height: 180 })}</div>
        <div class="tm-grid-2">${ui.skeleton("map", { height: 160 })}${ui.skeleton("kv", { rows: 4 })}</div>
      </div>`)}

      ${ui.section(`图标 ui.icon（${Object.keys(ICONS).length} 个）`, ui.card(html`<div class="tm-gallery-icons">${Object.keys(ICONS).map((k) => html`<div>${ui.icon(k)}<span>${k}</span></div>`)}</div>`))}
    `
  );

  // 分段选择：事件委托
  ui.onSegment(ctx.root, "period", (v) => {
    ctx.root.querySelector("#g-period").textContent = v;
  });

  ctx.root.querySelector("#g-menu").addEventListener("click", (e) => {
    ui.openSheet(
      e.currentTarget,
      ui.menu([
        { heading: "示例菜单" },
        { label: "在 Grafana 中打开", icon: "open-in-new", href: ctx.grafanaLink("Y8upc6ZRk"), external: true },
        { label: "选中的一项", icon: "car-side", checked: true, onClick: () => {} },
        { sep: true },
        { label: "关闭", icon: "close", onClick: () => {} }
      ]),
      { title: "示例菜单" }
    );
  });

  function retryDemo() {
    const box = ctx.root.querySelector("#g-error");
    ui.render(box, ui.skeleton("kv", { rows: 2 }));
    setTimeout(() => ui.render(box, ui.empty("重试成功（假的）", { icon: "check", title: "好了" })), 700);
  }

  // ---- 图表（ECharts 按需加载）
  const days = dailyKm();
  await Promise.all([
    chart.create(ctx.root.querySelector("#g-line"), {
      xAxis: chart.timeAxis(),
      yAxis: chart.valueAxis({ unit: "%", min: 0, max: 100 }),
      series: [
        chart.line("电量", soc.out, { color: "c1", area: true, fmt: (v) => fmt.pct(v, 1) }),
        chart.line("可用电量", soc.usable, { color: "c2", fmt: (v) => fmt.pct(v, 1) })
      ],
      dataZoom: chart.zoom()
    }),
    chart.create(ctx.root.querySelector("#g-bar"), {
      xAxis: chart.timeAxis({ minInterval: DAY }),
      yAxis: chart.valueAxis({ unit: fmt.unit.len }),
      series: [chart.bars("里程", days, { color: "c1", fmt: (v) => fmt.len(v), label: (v) => fmt.num(v[1]) })]
    }),
    chart.create(ctx.root.querySelector("#g-pie"), {
      legend: { show: true, bottom: 0, top: "auto", left: "center" },
      series: [
        {
          type: "pie",
          name: "充电量",
          center: ["50%", "44%"],
          data: [
            { name: "家", value: 241 },
            { name: "公司", value: 70 },
            { name: "超充", value: 47 },
            { name: "其它", value: 28 }
          ],
          label: { formatter: (p) => fmt.pct(p.percent) },
          tooltip: { valueFormatter: (v) => fmt.kwh(v) }
        }
      ]
    }),
    chart.create(ctx.root.querySelector("#g-scatter"), {
      xAxis: chart.valueAxis({ unit: fmt.unit.temp, name: "气温 " + fmt.unit.temp, scale: true }),
      yAxis: chart.valueAxis({ unit: fmt.unit.cons, scale: true }),
      tooltip: chart.tooltip((p) => chart.tipHtml("行程", [{ color: p.color, name: "气温", value: fmt.temp(p.value[0]) }, { color: p.color, name: "能耗", value: fmt.cons(p.value[1]) }])),
      series: [{ type: "scatter", name: "能耗", data: scatter(), itemStyle: { color: "@c3" } }]
    }),
    chart.create(ctx.root.querySelector("#g-heat"), {
      xAxis: chart.categoryAxis(Array.from({ length: 24 }, (_, h) => h + "时"), { splitArea: { show: false }, axisLine: { show: false } }),
      yAxis: chart.categoryAxis(["周一", "周二", "周三", "周四", "周五", "周六", "周日"], { inverse: true, splitLine: { show: false } }),
      visualMap: { min: 0, max: 9, show: true, text: ["多", "少"] },
      tooltip: chart.tooltip((p) => chart.tipHtml(`${["周一", "周二", "周三", "周四", "周五", "周六", "周日"][p.value[1]]} ${p.value[0]}时`, [{ name: "出发次数", value: p.value[2] + " 次" }])),
      series: [{ type: "heatmap", name: "出发次数", data: heat() }]
    }),
    chart.create(ctx.root.querySelector("#g-states"), {
      xAxis: chart.timeAxis({ min: today0(), max: today0() + DAY, splitLine: { show: true, lineStyle: { color: "@line" } } }),
      yAxis: chart.categoryAxis(["车辆", "活动"], { inverse: true, axisLine: { show: false } }),
      series: [chart.timelineSeries(states())]
    })
  ]);

  // ---- 地图（Leaflet 按需加载）
  const m = await map.create(ctx.root.querySelector("#g-map"));
  if (!m) return;
  const line = map.track(m, TRACK, { color: "accent" });
  map.marker(m, TRACK[0], { kind: "start", title: "出发：经十路", popup: "出发：经十路 <测试转义>" });
  map.marker(m, TRACK[TRACK.length - 1], { kind: "end", title: "到达：舜华路" });
  map.marker(m, [36.6536, 117.0872], { kind: "charge", title: "超充站", popup: html`<strong>超充站</strong><br>充了 ${fmt.kwh(35.1)}` });
  map.circles(m, [[36.6721, 117.0003, 3], [36.6402, 117.0301, 8], [36.6802, 117.0602, 5]], { radius: (w) => 4 + w, color: "violet" });
  map.fit(m, [line]);
}
