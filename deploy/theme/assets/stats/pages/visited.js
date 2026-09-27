// 足迹（对应 Grafana「Visited」面板 RG_DxSmgk）：
// 大地图画出范围内的全部轨迹（面板的 geomap），下面是面板的三格统计：里程、充电量（充入 / 用电 / 效率）、充电花费。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as map from "../core/map.js";
import { lenDigits } from "./_drive-item.js";

export const title = "足迹";
export const range = { default: "90d" };
export const css = true;

// ---------------------------------------------------------------- SQL（改编自面板，数字口径不变）

// 轨迹：和面板一样按分钟取平均位置、只要带续航读数的完整记录（streaming 推送点不要）。
// 另外去掉「和上一个点几乎同一位置」的点：停车时每隔几分钟一个的点全是原地（约占三成），
// 画出来只是一团抖动，还白白多传几百 KB。坐标保留 5 位小数（约 1 米），也是为了少传点
const TRACK_SQL = `with m as (
  select date_trunc('minute', timezone('UTC', date), '$__timezone') as time,
         avg(latitude) as latitude,
         avg(longitude) as longitude
  from positions
  where car_id = $car_id and $__timeFilter(date) and ideal_battery_range_km is not null
  group by 1
),
l as (
  select time, latitude, longitude,
         lag(latitude) over w as plat, lag(longitude) over w as plng
  from m
  window w as (order by time)
)
select time, round(latitude::numeric, 5) as lat, round(longitude::numeric, 5) as lng
from l
where plat is null or abs(latitude - plat) > 0.0003 or abs(longitude - plng) > 0.0004
order by time`;

// 面板「distance traveled」：范围内开始的行程，最大结束里程 − 最小开始里程（面板取整后拼上单位，这里返回数字自己格式化）。
// 行程次数只数已经结束的：进行中和中途断掉的不计入次数，和行程列表、驾驶统计对得上（CONVENTIONS (e)）
const MILEAGE_SQL = `select convert_km((max(end_km) - min(start_km))::numeric, '$length_unit') as mileage,
  count(*) filter (where end_date is not null) as drives
from drives where car_id = $car_id and $__timeFilter(start_date)`;

// 面板的充电量那格：充入、用电（取充入和用电里大的那个）、效率。只算充进超过 0.01 kWh 的
const ENERGY_SQL = `select
  count(*) as n,
  sum(charge_energy_added) as added,
  sum(greatest(charge_energy_added, charge_energy_used)) as used,
  sum(charge_energy_added) * 100 / nullif(sum(greatest(charge_energy_added, charge_energy_used)), 0) as efficiency
from charging_processes
where car_id = $car_id and $__timeFilter(start_date) and charge_energy_added > 0.01`;

// 面板「Total Charging Cost」：不过滤电量，所有充电的费用加起来
const COST_SQL = `select sum(cost) as cost from charging_processes where $__timeFilter(start_date) and car_id = $car_id`;

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  ui.render(ctx.root, ui.skeleton(["map", "stats"], { height: 360 }));

  // 统计很小、轨迹可能上兆（全部范围两万多个点），分两个请求同时发：统计先画出来，地图随后
  const load = () => api.batch({ track: { sql: TRACK_SQL, maxDataPoints: 100000 } }, { signal: ctx.signal });
  const trackP = load();
  // 统计出错时这个请求的结果没人等，别让它变成「未处理的 Promise 拒绝」
  trackP.catch(() => {});
  const d = await api.batch({ mileage: MILEAGE_SQL, energy: ENERGY_SQL, cost: COST_SQL }, { signal: ctx.signal });

  const m = d.mileage[0] || {};
  const e = d.energy[0] || {};
  const c = d.cost[0] || {};

  // 没有行程也没有充电时，还得看看有没有停车时的位置点，都没有才算空
  if (!m.drives && !e.n && c.cost == null) {
    const t = await trackP;
    if (!t.track.length) {
      ui.render(
        ctx.root,
        ui.card(
          ui.empty(`${ctx.range.label}没有行驶记录，地图上没有可画的轨迹。`, {
            icon: "map-outline",
            title: "没有足迹",
            action: ctx.range.key !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/visited", { r: "all" }) }) : null
          })
        )
      );
      return;
    }
  }

  ui.render(
    ctx.root,
    html`
      ${ui.card(
        // 这一页的主角就是地图：公共的内嵌地图最高占视口 45%，这里放宽到 60%（页面规格），手机上还剩四成屏幕给手指滚页面
        html`${ui.mapBox("pg-visited-map", { height: 640, maxVh: 60 })}
          <div class="pg-visited-foot tm-note" id="pg-visited-foot">正在读取轨迹…</div>`,
        { pad: false }
      )}
      ${ui.stats(
        [
          {
            label: "里程",
            icon: "road-variant",
            value: m.mileage,
            digits: lenDigits(m.mileage),
            unit: fmt.unit.len,
            sub: m.drives ? `${fmt.int(m.drives)} 次行程` : "没有行程"
          },
          {
            label: "充入电量",
            icon: "battery-charging-high",
            value: e.added,
            // 「全部」范围可能上万度，一位小数在 320 宽的格子里放不下
            digits: e.added >= 10000 ? 0 : 1,
            unit: "kWh",
            // 面板的「Total Energy used」（从电网取的电）
            sub: e.used != null ? `从电网取 ${fmt.kwh(e.used, 1)}` : "没有充电"
          },
          {
            label: "充电效率",
            icon: "flash-outline",
            value: e.efficiency,
            digits: 1,
            unit: "%",
            sub: e.n ? "充入 ÷ 用电" : null
          },
          {
            label: "充电花费",
            icon: "cash-multiple",
            value: c.cost != null ? fmt.money(c.cost) : null,
            // 单价不在这里算：充电页按「记了费用的那几次的用电量」算，这里的口径凑不出同一个数
            sub: c.cost == null ? "没有费用记录" : e.n ? `${fmt.int(e.n)} 次充电` : null
          }
        ],
        { cols: 4 }
      )}
    `
  );

  // 地图和轨迹同时准备（trackP 已经在路上了）
  const mp = await map.create(ctx.root.querySelector("#pg-visited-map"));
  if (!mp) return;
  await drawTrack(ctx, mp, trackP, load);
}

// 轨迹出错时只在地图下面报错（带重试），上面的统计数字留着，不让整页变成错误卡片
async function drawTrack(ctx, mp, trackP, load) {
  const foot = ctx.root.querySelector("#pg-visited-foot");
  let t;
  try {
    t = await trackP;
  } catch (e) {
    if (e.name === "AbortError") return;
    ui.render(
      foot,
      ui.error(e, () => {
        ui.render(foot, "正在读取轨迹…");
        drawTrack(ctx, mp, load(), load).catch(() => {});
      })
    );
    return;
  }
  // 面板把所有点连成一条线；TeslaMate 停机期间车开走了（库里没记录）时会凭空画出一条穿过地图的直线，
  // 所以按时间间隔和不可能的位移切段（map.tracks）。线细一点、半透明：一年的通勤会在同一条路上叠几百遍，粗线会糊成一片
  const g = map.tracks(mp, t.track, { color: "accent", weight: 3, opacity: 0.85 });
  if (!g.segments.length) {
    ui.render(foot, "这段时间没有可画的轨迹（位置点太少）。");
    return;
  }
  map.fit(mp, [g], { padding: 20 });
  ui.render(foot, `共 ${fmt.int(t.track.length)} 个轨迹点，按每分钟的平均位置绘制`);
}
