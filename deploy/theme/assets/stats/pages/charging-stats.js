/*
 * 充电统计（/stats/charging）—— 对应 Grafana「Charging Stats」面板（-pkIkhmRz）。
 *
 * SQL 基本照抄面板，保证数字和 Grafana 对得上。改动只有两类：
 *   - WHERE 条件完全相同的几格合成一条查询（次数 / 电量 / 花费 / 单价；交流直流的电量 / 时长 / 单价），
 *     聚合方式不变，只是少几次往返；
 *   - 地点名称换成 _shared.js 的写法：分组和面板一样（有围栏用围栏名，否则「地址, 城市」），显示用短名字 + 城市。
 * 面板变量：min_duration（最短时长，给高级用户的输入框）固定为 0；
 * geofence（收藏点，面板里可多选）做成页面顶部的筛选条，和充电列表页一样可以多选（URL 写法也一样：geofence=1,2）。
 */
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import * as chart from "../core/chart.js";
import * as map from "../core/map.js";
import { placeSql, placeFullSql, UNKNOWN_PLACE } from "./_shared.js";

export const title = "充电统计";
export const range = { default: "all" };
export const css = true;

// 排行榜最多列几个（面板是 17 个）；先显示几个、其余「展开全部」由 ui.rank 管
const TOP_LIMIT = 17;

// 筛选条展开与否：点收藏点会重画整页（新 root），展开状态要自己记
let filterOpen = false;

// 面板每条查询都带的收藏点条件：全部时 geofence = -1
const geo = (alias) => `('\${geofence:pipe}' = '-1' OR ${alias}.geofence_id in ($geofence))`;

function queries() {
  return {
    // # of Charges、Total Energy added、Total Charging Cost、Ø Cost per kWh：同一个 WHERE，合成一条
    // （no_cost 是额外的：费用为空的次数。它们的电量照样算进单价的分母，这里给个提示）
    // 除数都包一层 NULLIF(…, 0)：面板里除以 0 只是那一格报错，这里整批查询一起失败，整页就只剩错误卡片了
    sum: `SELECT count(*) AS n,
        sum(charge_energy_added) AS added,
        sum(cost) AS cost,
        count(*) FILTER (WHERE cost IS NULL) AS no_cost,
        sum(cost) / NULLIF(sum(greatest(charge_energy_added, charge_energy_used)), 0) AS per_kwh
      FROM charging_processes cp
      WHERE $__timeFilter(end_date) AND duration_min >= $min_duration AND car_id = $car_id AND ${geo("cp")}`,

    // SuC Charging Cost（原样）：按最后一条 charges 记录判断是不是特斯拉超充
    suc: `SELECT COALESCE(sum(cp.cost), 0) AS cost
      FROM charging_processes cp
      LEFT JOIN addresses addr ON addr.id = address_id
      LEFT JOIN geofences geo ON geo.id = geofence_id
      JOIN charges char ON char.charging_process_id = cp.id AND char.date = end_date
      WHERE $__timeFilter(end_date)
        AND (addr.name ILIKE '%supercharger%' OR geo.name ILIKE '%supercharger%' OR char.fast_charger_brand = 'Tesla')
        AND NULLIF(char.charger_phases, 0) IS NULL
        AND char.fast_charger_type != 'ACSingleWireCAN'
        AND cp.cost IS NOT NULL
        AND duration_min >= $min_duration
        AND cp.car_id = $car_id
        AND ${geo("cp")}`,

    // Ø Cost per 100 km（原样）：续航损失 × 车的能效 ÷ 里程 × 平均单价。范围不到 48 小时改用逐点数据。
    // 只多了两处 NULLIF：只充电没开车的那几天里程是 0，面板这一格会报「division by zero」，这里给 NULL（显示「—」）
    per100: `with drives_start_event as (
        select 'drive_start' as event, start_date as date, start_\${preferred_range}_range_km as range, start_km as odometer, car_id, distance is null as is_incomplete
        from drives
        where car_id = $car_id and $__timeFilter(start_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
      ),
      drives_end_event as (
        select 'drive_end' as event, case when end_date is null then start_date + interval '1 second' else end_date end as date, end_\${preferred_range}_range_km as range, end_km as odometer, car_id, distance is null as is_incomplete
        from drives
        where car_id = $car_id and $__timeFilter(start_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
      ),
      charging_processes_start_event as (
        select 'charging_process_start' as event, start_date as date, start_\${preferred_range}_range_km as range, p.odometer, cp.car_id, end_date is null as is_incomplete
        from charging_processes cp
          inner join positions p on cp.position_id = p.id
        where cp.car_id = $car_id and $__timeFilter(end_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
      ),
      charging_processes_end_event as (
        select 'charging_process_end' as event, case when end_date is null then start_date + interval '1 second' else end_date end as date, end_\${preferred_range}_range_km as range, p.odometer, cp.car_id, end_date is null as is_incomplete
        from charging_processes cp
          inner join positions p on cp.position_id = p.id
        where cp.car_id = $car_id and $__timeFilter(end_date) and 48 <= ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
      ),
      positions as (
        select
          case when drive_id is not null and lead(drive_id) over w is not null then 'drive_start' else 'something' end as event,
          date, \${preferred_range}_battery_range_km as range, p.odometer, p.car_id, false as is_incomplete
        from positions p
        where ideal_battery_range_km is not null and car_id = $car_id and 48 > ((\${__to:date:seconds} - \${__from:date:seconds})::numeric / 3600)
          and (drive_id in (select id from drives where $__timeFilter(start_date)) or drive_id is null and $__timeFilter(date))
        window w as (order by date)
      ),
      combined as (
        select * from drives_start_event
        union all select * from drives_end_event
        union all select * from charging_processes_start_event
        union all select * from charging_processes_end_event
        union all select * from positions
      ),
      final as (
        select
          car_id,
          case when is_incomplete then 0 else lead(odometer) over w - odometer end as distance,
          case when is_incomplete then 0 else case when event != 'drive_start' then greatest(range - lead(range) over w, 0) else range - lead(range) over w end end as range_loss
        from combined
        window w as (order by date asc)
      ),
      derived as (
        select convert_km(sum(distance)::numeric, '$length_unit') as distance, sum(range_loss) * c.efficiency as consumption
        from final inner join cars c on car_id = c.id
        group by c.efficiency
      ),
      charges as (
        SELECT sum(cost) / NULLIF(sum(charge_energy_added), 0) as cost_per_kwh
        FROM charging_processes cp
        where cp.car_id = $car_id and $__timeFilter(end_date) and ${geo("cp")}
      )
      select consumption / NULLIF(distance, 0) * 100 * cost_per_kwh as cost_mileage
      from derived cross join charges`,

    // AC/DC - Energy Used、AC/DC - Duration、Ø Cost per kWh AC / DC：都是先按充电过程判断交流 / 直流，合成一条
    // （相数的众数为空或 0 就是直流；RIGHT JOIN 照抄，没有 charges 记录的充电不算）
    acdc: `WITH data AS (
        SELECT cp.id, cp.cost, cp.charge_energy_added, cp.charge_energy_used, cp.duration_min,
          CASE WHEN NULLIF(mode() WITHIN GROUP (ORDER BY charger_phases), 0) IS NULL THEN 'DC' ELSE 'AC' END AS current
        FROM charging_processes cp
        RIGHT JOIN charges ON cp.id = charges.charging_process_id
        WHERE cp.car_id = $car_id AND cp.duration_min >= $min_duration AND $__timeFilter(end_date) AND ${geo("cp")}
        GROUP BY 1
      )
      SELECT current,
        count(*) AS n,
        sum(greatest(charge_energy_added, charge_energy_used)) AS energy,
        sum(duration_min) AS minutes,
        sum(cost) / NULLIF(sum(greatest(charge_energy_added, charge_energy_used)), 0) AS per_kwh
      FROM data GROUP BY 1`,

    // Charge Heatmap（原样）：每次充电的开始、结束电量，前端按「时间段 × 电量档」数次数
    soc: `SELECT end_date AS time, start_battery_level AS start_soc, end_battery_level AS end_soc
      FROM charging_processes cp
      WHERE $__timeFilter(end_date) AND duration_min >= $min_duration AND car_id = $car_id AND ${geo("cp")}
      ORDER BY end_date`,

    // Charge Delta（原样）：同一地点连续几次充电（里程表差不到 2）合成一次
    delta: `WITH charges AS (
        SELECT end_date, start_battery_level, end_battery_level, p.odometer,
          COALESCE(LAG(p.odometer) OVER (ORDER BY cp.end_date), p.odometer) AS odometer_prev
        FROM charging_processes cp
        JOIN positions p ON p.id = cp.position_id
        WHERE $__timeFilter(cp.end_date) AND cp.duration_min >= $min_duration AND cp.car_id = $car_id AND ${geo("cp")}
      )
      SELECT MIN(end_date) AS time, MIN(start_battery_level) AS start_soc, MAX(end_battery_level) AS end_soc
      FROM charges
      GROUP BY CASE WHEN odometer - odometer_prev < 2 THEN odometer_prev ELSE odometer END
      ORDER BY time`,

    // 磷酸铁锂电池：面板的参考线 / 颜色阈值换成 100%
    car: `SELECT lfp_battery FROM cars INNER JOIN car_settings ON cars.settings_id = car_settings.id WHERE cars.id = $car_id`,

    // Charging heat map by kWh：按地点汇总（Top Charging Stations (Charged) 是同一组数，按电量排序取前 17）。
    // geo_ids：收藏点的 id（排行榜链到充电列表时按收藏点筛；同名的几个收藏点合在一行，所以是列表）
    places: `SELECT ${placeFullSql("g", "a")} AS loc,
        min(${placeSql("g", "a")}) AS short,
        min(a.city) AS city,
        string_agg(DISTINCT g.id::text, ',') AS geo_ids,
        avg(p.latitude) AS latitude,
        avg(p.longitude) AS longitude,
        sum(cp.charge_energy_added) AS energy,
        count(*) AS n
      FROM charging_processes cp
      LEFT JOIN addresses a ON cp.address_id = a.id
      LEFT JOIN positions p ON cp.position_id = p.id
      LEFT JOIN geofences g ON cp.geofence_id = g.id
      WHERE $__timeFilter(cp.end_date) AND cp.duration_min >= $min_duration AND cp.car_id = $car_id AND ${geo("cp")}
      GROUP BY 1
      ORDER BY energy DESC NULLS LAST`,

    // Top Charging Stations (Cost)
    topCost: `SELECT ${placeFullSql("g", "a")} AS loc,
        min(${placeSql("g", "a")}) AS short,
        min(a.city) AS city,
        string_agg(DISTINCT g.id::text, ',') AS geo_ids,
        sum(cost) AS cost,
        count(*) AS n
      FROM charging_processes cp
      LEFT JOIN addresses a ON cp.address_id = a.id
      LEFT JOIN geofences g ON cp.geofence_id = g.id
      WHERE $__timeFilter(end_date) AND duration_min >= $min_duration AND car_id = $car_id AND cost IS NOT NULL AND ${geo("cp")}
      GROUP BY 1
      ORDER BY cost DESC NULLS LAST
      LIMIT ${TOP_LIMIT}`,

    // Charge Stats（原样）：结束电量分布；连续几次充电（中间没开车）只算最后一次
    endSoc: `with data as (
        select id, end_battery_level, end_date, 'Charging Process' as activity
        from charging_processes cp
        where cp.car_id = $car_id and $__timeFilter(cp.end_date) and duration_min >= $min_duration and ${geo("cp")}
        union all
        select d.id, p.battery_level as end_battery_level, end_date, 'Drive' as activity
        from drives d inner join positions p on d.end_position_id = p.id
        where d.car_id = $car_id and $__timeFilter(d.end_date)
      ),
      flag_consecutive_charges as (
        select *, lead(activity) over (order by end_date) as next_activity from data
      )
      SELECT ROUND(end_battery_level / 5, 0) * 5 AS soc, count(*) AS n
      FROM flag_consecutive_charges
      where activity = 'Charging Process' and (next_activity != 'Charging Process' or next_activity is null)
      GROUP BY ROUND(end_battery_level / 5, 0) * 5
      ORDER BY soc DESC`,

    // Discharge Stats（原样）：开始电量分布；连续几次充电只算第一次
    startSoc: `with data as (
        select id, start_battery_level, end_date, 'Charging Process' as activity
        from charging_processes cp
        where cp.car_id = $car_id and $__timeFilter(cp.end_date) and duration_min >= $min_duration and ${geo("cp")}
        union all
        select d.id, p.battery_level as start_battery_level, end_date, 'Drive' as activity
        from drives d inner join positions p on d.start_position_id = p.id
        where d.car_id = $car_id and $__timeFilter(d.end_date)
      ),
      flag_consecutive_charges as (
        select *, lag(activity) over (order by end_date) as previous_activity from data
      )
      SELECT ROUND(start_battery_level / 5, 0) * 5 AS soc, count(*) AS n
      FROM flag_consecutive_charges
      where activity = 'Charging Process' and (previous_activity != 'Charging Process' or previous_activity is null)
      GROUP BY ROUND(start_battery_level / 5, 0) * 5
      ORDER BY soc DESC`,

    // DC Charging Curve A：每次直流充电在每个电量下的平均功率。
    // 面板还按地址名、围栏名、起止时间分组，它们都由充电过程决定，不影响结果，这里用 min() 取出来
    dc: `SELECT c.battery_level AS soc,
        round(avg(c.charger_power), 0) AS power,
        c.charging_process_id AS id,
        min(p.start_date) AS start_date,
        min(${placeSql("g", "a")}) AS name
      FROM charges c
      JOIN charging_processes p ON p.id = c.charging_process_id
      JOIN addresses a ON a.id = p.address_id
      LEFT JOIN geofences g ON g.id = p.geofence_id
      WHERE $__timeFilter(date) AND p.car_id = $car_id AND charger_power > 0 AND c.fast_charger_present AND ${geo("p")}
      GROUP BY c.battery_level, c.charging_process_id, to_char(timezone('$__timezone', timezone('UTC', c.date)), 'YYYY-MM-dd')`,

    // DC Charging Curve B（原样）：每个电量下的功率中位数
    dcMedian: `SELECT c.battery_level AS soc, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY charger_power) AS power
      FROM charges c
      JOIN charging_processes p ON p.id = c.charging_process_id
      WHERE $__timeFilter(date) AND p.car_id = $car_id AND charger_power > 0 AND c.fast_charger_present AND ${geo("p")}
      GROUP BY battery_level
      ORDER BY battery_level`,

    // 顶部筛选用
    geofences: `SELECT id, name FROM geofences ORDER BY name, id`
  };
}

// ---------------------------------------------------------------- 小工具

// 各页统一：电量 kWh 一位小数，费用两位小数
const kwhText = (v) => fmt.kwh(v, 1);
const placeTitle = (r) => r.short || UNKNOWN_PLACE;
// 不是收藏点的地方，名字后面补城市（超充站在各地重名的多）
const placeCity = (r) => (!r.geo_ids && r.city && r.city !== r.short ? r.city : null);

function share(part, total) {
  return total > 0 && Number.isFinite(part) ? (part / total) * 100 : null;
}

// 占比取整（各页统一）；不到 1% 的写「<1%」、差一点到 100% 的写「>99%」，免得出现「0%」和「100%」并排
const pctText = (v) => (v != null && v > 0 && v < 1 ? "<1%" : v != null && v > 99 && v < 100 ? ">99%" : fmt.pct(v));

// ---------------------------------------------------------------- 渲染

export async function render(ctx) {
  ctx.root.classList.add("pg-cs");
  ui.render(ctx.root, ui.skeleton(["stats", "chart", "chart", "list"]));

  // 收藏点筛选：geofence=1 或 1,2（和充电列表页同一种写法，面板里也是多选）。坏项跳过，不报「找不到记录」
  const geoIds = api.intList(ctx.query.get("geofence"), { max: 20, min: 1 });

  const d = await api.batch(queries(), {
    signal: ctx.signal,
    vars: { min_duration: 0, geofence: geoIds.length ? geoIds : "-1" }
  });

  const s = d.sum[0] || {};
  const fences = d.geofences;
  const names = geoIds.map((id) => (fences.find((g) => g.id === id) || { name: `收藏点 #${id}` }).name);
  // 页头「⋯ → 在 Grafana 中打开」带上同样的收藏点（多选写成多个 var-geofence，空数组就不带）
  ctx.setGrafanaVars({ "var-geofence": geoIds });

  const filter = filterBar(ctx, fences, geoIds, names);

  if (!s.n) {
    ui.render(
      ctx.root,
      html`${geoIds.length ? filter : ""}${ui.card(
        geoIds.length
          ? ui.empty("换个条件试试，或者清除筛选。", {
              icon: "filter-variant",
              title: "没有符合条件的充电",
              action: ui.button("清除筛选", { kind: "soft", attrs: { "data-cs-clear": "" } })
            })
          : ui.empty(ctx.range.kind === "all" ? "还没有充电记录。" : `${ctx.range.label}没有充电记录。`, {
              icon: "ev-station",
              title: "没有充电",
              action: ctx.range.kind !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/charging", { r: "all" }) }) : null
            })
      )}`
    );
    bindFilter(ctx, geoIds);
    return;
  }

  const ac = d.acdc.find((r) => r.current === "AC") || null;
  const dc = d.acdc.find((r) => r.current === "DC") || null;
  const suc = d.suc[0] ? d.suc[0].cost : null;
  const per100 = d.per100[0] ? d.per100[0].cost_mileage : null;
  const lfp = !!(d.car[0] && d.car[0].lfp_battery);
  const perLen = fmt.unit.len === "mi" ? "每百英里花费" : "每百公里花费";

  const stats = ui.stats(
    [
      { label: "充电次数", value: s.n, unit: "次", icon: "ev-station", sub: ac || dc ? `交流 ${ac ? ac.n : 0} · 直流 ${dc ? dc.n : 0}` : null },
      { label: "充入电量", value: s.added, digits: 1, unit: "kWh", icon: "battery-charging-high", sub: `平均每次 ${kwhText(s.added / s.n)}` },
      { label: "总花费", value: fmt.money(s.cost), icon: "cash-multiple", sub: s.no_cost ? `${s.no_cost} 次没有记录费用` : null },
      { label: "超充花费", value: fmt.money(suc), icon: "lightning-bolt", sub: s.cost > 0 && suc != null ? `占总花费 ${pctText(share(suc, s.cost))}` : null },
      // 面板的算法：行驶耗电 × 每度「充入电量」的花费（不是旁边按用电量算的平均单价）
      { label: perLen, value: fmt.money(per100), icon: "road-variant", sub: per100 != null ? "按行驶耗电折算" : s.cost == null ? "没有费用记录" : "这段时间没有行驶" },
      { label: "平均单价", value: fmt.money(s.per_kwh), unit: "/度", icon: "tag-outline", sub: "按用电量算" },
      { label: "交流单价", value: fmt.money(ac && ac.per_kwh), unit: "/度", icon: "power-plug-outline", sub: ac ? `用电 ${kwhText(ac.energy)}` : "没有交流充电" },
      { label: "直流单价", value: fmt.money(dc && dc.per_kwh), unit: "/度", icon: "flash-outline", sub: dc ? `用电 ${kwhText(dc.energy)}` : "没有直流快充" }
    ],
    { cols: 4 }
  );

  // 地点：按电量排序；排行榜和地图用同一组数
  const placeTotal = d.places.reduce((a, r) => a + (r.energy || 0), 0);
  const topEnergy = d.places.filter((r) => r.energy > 0).slice(0, TOP_LIMIT);
  const costTotal = d.topCost.reduce((a, r) => a + (r.cost || 0), 0);

  const limits = lfp ? { lower: 20, upper: 100 } : { lower: 20, upper: 80 };
  // 两张时间图的横轴铺满所选范围（和 Grafana 一样；不固定的话只有一两次充电时 ECharts 会把轴撑成好几年）。
  // 「全部」这类比接入时间还早的范围，从这辆车有数据的那一刻画起（effFrom）
  const span = { from: ctx.range.effFrom, to: ctx.range.to };
  const heat = heatData(d.soc, span);

  ui.render(
    ctx.root,
    html`
      ${filter}
      ${stats}
      ${ui.section("交流和直流", ui.card(splitCard(ac, dc)))}
      <div class="tm-grid-2">
        ${ui.section(
          "每次充了多少",
          ui.card(ui.chartBox("cs-delta", { height: 290, heightMobile: 230, label: "每次充电的开始和结束电量" })),
          { sub: `柱子从开始电量画到结束电量；虚线是 ${limits.lower}% 和 ${limits.upper}%` }
        )}
        ${ui.section(
          "充电时的电量分布",
          ui.card(ui.chartBox("cs-heat", { height: 290, heightMobile: 280, label: "开始和结束电量的分布" })),
          { sub: `开始、结束电量各算一次，${heat ? heat.unitLabel : "按月"}统计，颜色越深次数越多` }
        )}
      </div>
      <div class="tm-grid-2">
        ${ui.section(
          "直流快充曲线",
          d.dc.length
            ? ui.card(ui.chartBox("cs-dc", { height: 300, heightMobile: 260, label: "直流充电功率和电量的关系" }))
            : ui.card(ui.empty("这段时间没有直流快充。", { icon: "flash-outline" })),
          { sub: d.dc.length ? "每个点是一次快充在某个电量下的平均功率，点一下打开那次充电" : null }
        )}
        ${ui.section(
          "充电地点",
          d.places.some((r) => r.latitude != null)
            ? ui.card(ui.mapBox("cs-map", { height: 340 }), { pad: false })
            : ui.card(ui.empty("没有位置数据。", { icon: "map-outline" })),
          { sub: "圆越大充的电越多，点圆圈看详情" }
        )}
      </div>
      <div class="tm-grid-2">
        ${ui.section(
          "充电最多的地点",
          ui.card(
            ui.rank(
              topEnergy.map((r) => ({
                name: placeTitle(r),
                href: chargesHref(ctx, r),
                value: r.energy,
                text: kwhText(r.energy),
                sub: ui.segs([placeCity(r), `${r.n} 次`, `占 ${pctText(share(r.energy, placeTotal))}`])
              })),
              { tone: "green" }
            )
          ),
          { sub: "点地点看在那里的每次充电" }
        )}
        ${ui.section(
          "花钱最多的地点",
          ui.card(
            d.topCost.length
              ? ui.rank(
                  d.topCost.map((r) => ({
                    name: placeTitle(r),
                    href: chargesHref(ctx, r),
                    value: r.cost,
                    text: fmt.money(r.cost),
                    sub: ui.segs([placeCity(r), `${r.n} 次有费用`, `占 ${pctText(share(r.cost, costTotal))}`])
                  })),
                  { tone: "amber" }
                )
              : ui.empty("这段时间的充电都没有记录费用。", { icon: "cash-multiple" })
          ),
          { sub: "只算记录了费用的充电" }
        )}
      </div>
      <div class="tm-grid-2">
        ${ui.section(
          "充到多少",
          ui.card(socList(d.endSoc, (soc) => (lfp ? null : soc >= 91 ? "red" : soc >= 81 ? "amber" : null))),
          { sub: lfp ? "充电结束时的电量。连续几次充电（中间没开车）只算最后一次" : "充电结束时的电量，超过 80% 标黄、超过 90% 标红。连续几次充电只算最后一次" }
        )}
        ${ui.section(
          "从多少开始充",
          ui.card(socList(d.startSoc, (soc) => (soc < 10 ? "red" : soc < 20 ? "amber" : null))),
          { sub: "开始充电时的电量，低于 20% 标黄、低于 10% 标红。连续几次充电只算第一次" }
        )}
      </div>
    `
  );

  bindFilter(ctx, geoIds);

  await Promise.all([
    drawDelta(ctx, d.delta, limits, span),
    drawHeat(ctx, heat),
    d.dc.length ? drawDc(ctx, d.dc, d.dcMedian) : null
  ]);
  await drawMap(ctx, d.places, placeTotal);
}

// 排行榜的一行链到充电列表，范围和这里一样：收藏点按 geofence 筛，别的地方按列表上显示的短地名搜
// （充电列表的搜索也搜短地名）。没反查到地址的地方没法筛，不做链接
function chargesHref(ctx, r) {
  const ids = api.intList(r.geo_ids);
  if (ids.length) return ctx.href("/stats/charges", { r: ctx.range.key, geofence: ids.join(",") });
  if (!r.short) return null;
  return ctx.href("/stats/charges", { r: ctx.range.key, q: r.short, geofence: null });
}

// ---------------------------------------------------------------- 收藏点筛选（筛选条，样子和充电列表页的一样）

function filterBar(ctx, fences, geoIds, names) {
  if (!fences.length && !geoIds.length) return "";
  return ui.filterBar({
    summary: geoIds.length ? [names.join("、")] : [],
    hint: "按收藏点筛选",
    open: filterOpen,
    onToggle: (o) => (filterOpen = o),
    onClear: () => ctx.setQuery({ geofence: null }),
    body: html`<div class="tm-field">
      <span>收藏点</span>
      <div class="tm-flex" role="group" aria-label="只看在这些收藏点的充电">
        <button type="button" class="tm-chip" data-cs-geo="" aria-pressed="${geoIds.length ? "false" : "true"}">全部</button>
        ${fences.map(
          (g) => html`<button type="button" class="tm-chip" data-cs-geo="${g.id}" aria-pressed="${geoIds.includes(g.id) ? "true" : "false"}">${g.name}</button>`
        )}
      </div>
      <span class="tm-note">可以多选；只看在这些收藏点里的充电</span>
    </div>`
  });
}

function bindFilter(ctx, geoIds) {
  ctx.root.addEventListener("click", (e) => {
    if (e.target.closest("[data-cs-clear]")) {
      ctx.setQuery({ geofence: null });
      return;
    }
    const chip = e.target.closest("[data-cs-geo]");
    if (!chip) return;
    const id = chip.dataset.csGeo ? +chip.dataset.csGeo : null;
    const next = id == null ? [] : geoIds.includes(id) ? geoIds.filter((x) => x !== id) : [...geoIds, id];
    ctx.setQuery({ geofence: next.length ? next.join(",") : null });
  });
}

// ---------------------------------------------------------------- 交流 / 直流占比（两段式横条，比两片的饼图好读）

function splitCard(ac, dc) {
  const block = (label, a, b, text) => {
    const total = (a || 0) + (b || 0);
    const pa = share(a || 0, total);
    const pb = share(b || 0, total);
    return html`<div class="pg-cs-split">
      <div class="tm-between"><span class="tm-strong">${label}</span><span class="tm-num tm-small tm-muted">合计 ${text(total)}</span></div>
      <div class="pg-cs-split-bar" role="img" aria-label="${`${label}：交流 ${pctText(pa)}，直流 ${pctText(pb)}`}">
        ${a > 0 ? html`<span class="is-ac" style="${`flex-grow:${a}`}"></span>` : ""}
        ${b > 0 ? html`<span class="is-dc" style="${`flex-grow:${b}`}"></span>` : ""}
      </div>
      <div class="pg-cs-split-legend">
        <span><i class="is-ac"></i>交流 <b class="tm-num">${a > 0 ? text(a) : "没有"}</b>${a > 0 ? html`<em>${pctText(pa)}</em>` : ""}</span>
        <span><i class="is-dc"></i>直流 <b class="tm-num">${b > 0 ? text(b) : "没有"}</b>${b > 0 ? html`<em>${pctText(pb)}</em>` : ""}</span>
      </div>
    </div>`;
  };
  if (!ac && !dc) return ui.empty("没有充电明细，分不出交流和直流。", { icon: "power-plug-outline" });
  return html`<div class="pg-cs-splits">
    ${block("用电量", ac && ac.energy, dc && dc.energy, kwhText)}
    ${block("充电时长", ac && ac.minutes, dc && dc.minutes, (v) => fmt.duration(v))}
  </div>`;
}

// ---------------------------------------------------------------- 电量分布（Charge Stats / Discharge Stats）

function socList(rows, toneOf) {
  if (!rows.length) return ui.empty("没有数据。");
  const max = Math.max(...rows.map((r) => r.n));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return html`<div class="pg-cs-soc">${rows.map((r) => {
    const t = toneOf(r.soc);
    return html`<div class="pg-cs-soc-row">
      <span class="pg-cs-soc-label tm-num${t ? ` tm-tone-${t}` : ""}">${fmt.pct(r.soc)}</span>
      ${ui.bar(r.n, max, t || "accent")}
      <span class="pg-cs-soc-n tm-num">${r.n} 次<em>${pctText(share(r.n, total))}</em></span>
    </div>`;
  })}</div>`;
}

// ---------------------------------------------------------------- 每次充了多少（Charge Delta）

async function drawDelta(ctx, rows, limits, span) {
  const el = ctx.root.querySelector("#cs-delta");
  if (!rows.length) {
    ui.render(el.parentElement, ui.empty("没有数据。"));
    return;
  }
  const data = rows.map((r) => [r.time, r.start_soc, r.end_soc]);
  const n = data.length;
  await chart.create(el, {
    // 横轴顶到范围两端时，靠边的刻度（比如 90 天范围里的「9月22日」）标签会伸出图外被切掉，右边多留一点
    xAxis: chart.timeAxis(span ? { min: span.from, max: span.to } : { boundaryGap: ["3%", "3%"] }),
    grid: span ? { right: 24 } : undefined,
    yAxis: chart.valueAxis({ unit: "%", min: 0, max: 100 }),
    tooltip: chart.tooltip((p) =>
      chart.tipHtml(fmt.dateTime(p.value[0]), [
        { color: p.color, name: "电量", value: `${fmt.pct(p.value[1])} → ${fmt.pct(p.value[2])}` },
        { name: "充了", value: `${fmt.num(p.value[2] - p.value[1])} 个百分点` }
      ])
    ),
    dataZoom: n > 60 ? chart.zoom() : undefined,
    series: [
      {
        type: "custom",
        name: "充电",
        encode: { x: 0, y: [1, 2] },
        itemStyle: { color: "@c4" },
        // 每次充电一根「悬空」的柱子：从开始电量到结束电量。柱宽按根数分，2~10px
        renderItem(params, api) {
          const x = api.value(0);
          const a = api.coord([x, api.value(1)]);
          const b = api.coord([x, api.value(2)]);
          const cs = params.coordSys;
          const w = Math.max(2, Math.min(10, (cs.width / n) * 0.6));
          if (a[0] < cs.x - w || a[0] > cs.x + cs.width + w) return null;
          return {
            type: "rect",
            shape: { x: a[0] - w / 2, y: b[1], width: w, height: Math.max(2, a[1] - b[1]), r: Math.min(2, w / 2) },
            style: { fill: api.visual("color") }
          };
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "@green", type: "dashed", width: 1, opacity: 0.8 },
          label: { show: false },
          data: [{ yAxis: limits.lower }, { yAxis: limits.upper }]
        },
        data
      }
    ]
  });
}

// ---------------------------------------------------------------- 电量分布热力图（Charge Heatmap）
// 面板是「时间 × 电量档」：开始、结束电量各算一次，按 10% 一档。面板的档宽是 10.00001，
// 所以 80% 落在「71–80」这一档、100% 落在「91–100」，这里照做

const SOC_BUCKETS = Array.from({ length: 10 }, (_, i) => (i === 0 ? "0–10" : `${i * 10 + 1}–${i * 10 + 10}`));
const socBucket = (v) => Math.max(0, Math.min(9, Math.floor(v / 10.00001)));

function startOf(unit, ms) {
  const d = new Date(ms);
  if (unit === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (unit === "week") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

function nextOf(unit, t) {
  const d = new Date(t);
  if (unit === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (unit === "week" ? 7 : 1)).getTime();
}

function heatData(rows, span) {
  const pts = rows.filter((r) => r.time != null);
  if (!pts.length) return null;
  const first = span ? span.from : pts[0].time;
  const last = span ? span.to : pts[pts.length - 1].time;
  // 时间段随跨度变：半年以上按月，一个多月按周，再短按天
  const width = last - first;
  const unit = width > 150 * DAY ? "month" : width > 35 * DAY ? "week" : "day";
  const cols = [];
  for (let t = startOf(unit, first); t <= last; t = nextOf(unit, t)) cols.push(t);
  const index = new Map(cols.map((t, i) => [t, i]));
  const cells = cols.map(() => SOC_BUCKETS.map(() => ({ start: 0, end: 0 })));
  for (const r of pts) {
    const col = cells[index.get(startOf(unit, r.time))];
    if (!col) continue;
    if (r.start_soc != null) col[socBucket(r.start_soc)].start++;
    if (r.end_soc != null) col[socBucket(r.end_soc)].end++;
  }
  const data = [];
  let max = 0;
  cells.forEach((col, x) =>
    col.forEach((c, y) => {
      const v = c.start + c.end;
      max = Math.max(max, v);
      data.push([x, y, v, c.start, c.end]);
    })
  );
  const label = (t, i) => {
    const d = new Date(t);
    if (unit === "month") return i === 0 || d.getMonth() === 0 ? `${d.getFullYear()}年${d.getMonth() + 1}月` : `${d.getMonth() + 1}月`;
    return fmt.date(t);
  };
  const title = (t) => (unit === "month" ? fmt.month(t) : unit === "week" ? `${fmt.dateAuto(t)} 那一周` : `${fmt.dateAuto(t)} ${fmt.weekday(t)}`);
  return {
    unit,
    unitLabel: unit === "month" ? "按月" : unit === "week" ? "按周" : "按天",
    labels: cols.map(label),
    titles: cols.map(title),
    data,
    max
  };
}

async function drawHeat(ctx, h) {
  const el = ctx.root.querySelector("#cs-heat");
  if (!h) {
    ui.render(el.parentElement, ui.empty("没有数据。"));
    return;
  }
  await chart.create(el, {
    xAxis: chart.categoryAxis(h.labels, { splitArea: { show: false }, axisLine: { show: false } }),
    yAxis: chart.categoryAxis(SOC_BUCKETS, { name: "电量 %", nameLocation: "end", nameGap: 8, nameTextStyle: { align: "left" }, splitLine: { show: false } }),
    visualMap: { min: 0, max: Math.max(1, h.max), show: true, text: ["多", "少"], dimension: 2 },
    tooltip: chart.tooltip((p) =>
      chart.tipHtml(`${h.titles[p.value[0]]} · 电量 ${SOC_BUCKETS[p.value[1]]}%`, [
        { name: "开始充电", value: `${p.value[3]} 次` },
        { name: "充完", value: `${p.value[4]} 次` }
      ])
    ),
    series: [{ type: "heatmap", name: "次数", data: h.data }]
  });
}

// ---------------------------------------------------------------- 直流快充曲线（DC Charging Curve）

async function drawDc(ctx, rows, median) {
  // 数据用数组（chart.js 不会逐个去解析颜色），名字、日期另外按下标查
  const meta = rows.map((r) => ({ id: r.id, name: r.name || UNKNOWN_PLACE, date: r.start_date }));
  const pts = rows.map((r, i) => [r.soc, r.power, i]);
  const mid = new Map(median.map((r) => [r.soc, r.power]));
  await chart.create(
    ctx.root.querySelector("#cs-dc"),
    {
      xAxis: chart.valueAxis({ name: "电量 %", min: 0, max: 100 }),
      yAxis: chart.valueAxis({ unit: "kW", min: 0 }),
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const m = meta[p.value[2]];
          if (!m) return "";
          return chart.tipHtml(`${m.name} · ${fmt.dateAuto(m.date)}`, [
            { color: p.color, name: `电量 ${fmt.pct(p.value[0])} 时`, value: fmt.kw(p.value[1]) },
            mid.has(p.value[0]) ? { color: chart.color("c1"), name: "所有快充的中位数", value: fmt.kw(mid.get(p.value[0])) } : null
          ]);
        }
      },
      series: [
        {
          type: "scatter",
          name: "每次快充",
          data: pts,
          symbolSize: 7,
          itemStyle: { color: "@c2", opacity: 0.6 },
          emphasis: { itemStyle: { opacity: 1 } },
          cursor: "pointer"
        },
        {
          // 中位数线只看不点（silent）：它穿过点最密的地方，能点的话会挡住下面的散点。数值放在散点的提示框里
          ...chart.line("中位数", median.map((r) => [r.soc, r.power]), { color: "c1", width: 2 }),
          silent: true,
          z: 3
        }
      ]
    },
    {
      onClick: (p) => {
        if (p.seriesIndex !== 0) return;
        const m = meta[p.value[2]];
        if (m) ctx.navigate(`/stats/charges/${m.id}`);
      }
    }
  );
}

// ---------------------------------------------------------------- 充电地点地图（Charging heat map by kWh）

async function drawMap(ctx, places, total) {
  const el = ctx.root.querySelector("#cs-map");
  if (!el) return;
  const pts = places.filter((r) => r.latitude != null && r.longitude != null && r.energy > 0);
  const m = await map.create(el);
  if (!m) return;
  const max = Math.max(1, ...pts.map((r) => r.energy));
  // 面积和电量成正比：半径按平方根，6~26px
  const layer = map.circles(
    m,
    pts.map((r) => [r.latitude, r.longitude, r.energy, r]),
    {
      radius: (w) => 6 + 20 * Math.sqrt(w / max),
      color: "accent",
      opacity: 0.45,
      stroke: true,
      popup: (p) => {
        const r = p[3];
        return html`<strong>${placeTitle(r)}</strong>${!r.fenced && r.city && r.city !== r.short ? html`<br>${r.city}` : ""}<br>
          ${kwhText(r.energy)} · 占 ${pctText(share(r.energy, total))} · ${r.n} 次`;
      }
    }
  );
  // 边距要比最大的圆（半径 26px）大，不然落在范围边上的地点只露半个圆，还会被右上角的全屏按钮盖住
  map.fit(m, [layer], { maxZoom: 14, padding: 48 });
}
