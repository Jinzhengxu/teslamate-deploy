// 地点（对应 Grafana「Locations」面板 ZzhF-aRWz）：
// 顶部四个数 = 面板的地址 / 城市 / 省份 / 国家数，两个排行 = 面板的 Cities / States 横条，
// 收藏点 = 面板的 Geo-fences 表，最近到访 / 地址 = 面板的 Last visited / Addresses 表（搜索对应面板的 address_filter）。
// 面板没有的「到达几次、充电几次」是补上的：光有地址名单看不出哪儿常去。
import { html } from "../core/ui.js";
import * as ui from "../core/ui.js";
import * as api from "../core/api.js";
import * as fmt from "../core/format.js";
import { placeSql, UNKNOWN_PLACE } from "./_shared.js";

export const title = "地点";
export const range = { default: "1y" };
export const css = true;

// 最近到访、地址两张列表每次显示几条（查询最多取 100 条，都在手上）
const PAGE = 10;

// ---------------------------------------------------------------- SQL（改编自面板，数字口径不变）

// 面板里每张表都用这一段圈定「范围内到过的地址」：行程的起点、终点，加上充电的地方
const ADDRESS_IDS = `select start_address_id from drives where car_id = $car_id and $__timeFilter(start_date)
  union
  select end_address_id from drives where car_id = $car_id and $__timeFilter(end_date)
  union
  select address_id from charging_processes where car_id = $car_id and ($__timeFilter(start_date) or $__timeFilter(end_date))`;

const GEOFENCE_IDS = `select start_geofence_id from drives where car_id = $car_id and $__timeFilter(start_date)
  union
  select end_geofence_id from drives where car_id = $car_id and $__timeFilter(end_date)
  union
  select geofence_id from charging_processes where car_id = $car_id and ($__timeFilter(start_date) or $__timeFilter(end_date))`;

// 到达次数（行程终点在这里、结束时间在范围内）和充电次数（和面板圈地址的条件一样）
const VISITS = `arr as (
  select end_address_id as id, count(*) as n, max(end_date) as last, max(end_geofence_id) as gid
  from drives where car_id = $car_id and $__timeFilter(end_date) group by 1
),
chg as (
  select address_id as id, count(*) as n, max(start_date) as last, max(geofence_id) as gid
  from charging_processes where car_id = $car_id and ($__timeFilter(start_date) or $__timeFilter(end_date)) group by 1
)`;

// addr：搜索词的 ilike 模式（api.like 的结果），没有搜索词时是「%%」，和面板一样也会滤掉 display_name 为空的地址
const queries = (addr) => ({
  // 面板「# of Addresses / Cities / States / Countries」
  counts: `select count(*) as addresses, count(distinct city) as cities, count(distinct state) as states, count(distinct country) as countries
from addresses where id in (${ADDRESS_IDS})`,

  // 面板「Cities」「States」：按地址个数排前 10
  cities: `select city as name, count(*) as n
from addresses
where city is not null and id in (${ADDRESS_IDS})
group by 1 order by 2 desc, 1 limit 10`,

  states: `select state as name, count(*) as n
from addresses
where state is not null and id in (${ADDRESS_IDS})
group by 1 order by 2 desc, 1 limit 10`,

  // 面板「Geo-fences」+ 到达 / 充电次数。面板按创建时间倒序，这里按到达次数排（常去的在前）
  geofences: `with arr as (
  select end_geofence_id as id, count(*) as n, max(end_date) as last
  from drives where car_id = $car_id and $__timeFilter(end_date) group by 1
),
chg as (
  select geofence_id as id, count(*) as n
  from charging_processes where car_id = $car_id and ($__timeFilter(start_date) or $__timeFilter(end_date)) group by 1
)
select g.id, g.name, coalesce(arr.n, 0) as arrivals, coalesce(chg.n, 0) as charges, arr.last
from geofences g
left join arr on arr.id = g.id
left join chg on chg.id = g.id
where g.id in (${GEOFENCE_IDS})
order by coalesce(arr.n, 0) desc, g.inserted_at desc
limit 100`,

  // 面板「Last visited」：地址按「围栏名，或完整地址的前两段」合并，取最后一次到达（充电的开始也算）。
  // 面板的 SQL 没有排序（表格上按日期倒序显示），超过 100 个时取到哪 100 个说不准，这里先排序再取
  recent: `with locations as (
  select address_id, geofence_id, start_date as end_date from charging_processes where car_id = $car_id and ($__timeFilter(start_date) or $__timeFilter(end_date))
  union
  select end_address_id as address_id, end_geofence_id as geofence_id, end_date from drives where car_id = $car_id and $__timeFilter(end_date)
)
select max(l.end_date) as date,
       coalesce(g.name, array_to_string(((string_to_array(a.display_name, ', ', ''))[0:2]), ', ')) as address,
       coalesce(city, neighbourhood) as city,
       max(g.id) as geofence_id,
       min(${placeSql("g", "a")}) as place
from locations l
inner join addresses a on l.address_id = a.id
left join geofences g on l.geofence_id = g.id
where (a.display_name ilike ${addr} or g.name ilike ${addr})
group by 2, 3
order by 1 desc
limit 100`,

  // 面板「Addresses」+ 到达 / 充电次数，以及到这个地址的行程落在哪个收藏点里（落在收藏点里就不再提示「设为收藏点」）。
  // 面板按地址入库时间倒序，这里按到达次数排
  addresses: `with ${VISITS}
select a.id, a.latitude, a.longitude,
       coalesce(a.name, concat(a.road, ' ', a.house_number)) as name,
       a.neighbourhood, a.city, a.state, a.country,
       coalesce(arr.n, 0) as arrivals, coalesce(chg.n, 0) as charges,
       greatest(arr.last, chg.last) as last,
       g.id as geofence_id, g.name as geofence
from addresses a
left join arr on arr.id = a.id
left join chg on chg.id = a.id
left join geofences g on g.id = coalesce(arr.gid, chg.gid)
where a.display_name ilike ${addr} and a.id in (${ADDRESS_IDS})
order by coalesce(arr.n, 0) desc, coalesce(chg.n, 0) desc, a.inserted_at desc
limit 100`
});

// ---------------------------------------------------------------- 小工具

// 城市、省份排行（面板只取前 10 个，全部显示）
function ranking(rows, tone, empty) {
  return ui.rank(rows.map((x) => ({ name: x.name, value: x.n })), { tone, unit: "个地址", shown: 0, empty });
}

// 行程页的地点筛选链接。地名只进 URL 查询参数（路径是固定的，URLSearchParams 会编码），不会变成可执行的链接
function drivesHref(ctx, { geofenceId, place }) {
  const q = { r: ctx.range.key };
  if (geofenceId != null) q.geofence = geofenceId;
  else if (place) q.q = place;
  else return null;
  return ctx.href("/stats/drives", q);
}

// 列表的占位：有数据时是给 pager 的空容器（render 之后 drawList 填），没有时直接是空状态
function listBox(id, items, empty) {
  return items.length ? html`<div id="${id}"></div>` : ui.card(ui.empty(empty, { icon: "magnify" }));
}

// 先 PAGE 条，「再显示」往下加；卡片带 data-tm-append，下一页的行并进同一张卡片
function drawList(el, items, noun) {
  if (!el) return;
  ui.pager(el, {
    total: items.length,
    page: PAGE,
    noun,
    load: (offset) => ui.card(ui.list(items.slice(offset, offset + PAGE)), { pad: false, attrs: { "data-tm-append": "list" } })
  });
}

// ---------------------------------------------------------------- 页面

export async function render(ctx) {
  const text = (ctx.query.get("q") || "").trim().slice(0, 60);
  ctx.setGrafanaVars({ "var-address_filter": text || null });

  ui.render(ctx.root, ui.skeleton(["stats", "list"]));

  const d = await api.batch(queries(api.like(text)), { signal: ctx.signal });
  const c = d.counts[0] || {};

  if (!c.addresses && !d.geofences.length) {
    ui.render(
      ctx.root,
      ui.card(
        ui.empty(`${ctx.range.label}没有到过任何地方（没有行程和充电）。`, {
          icon: "map-marker-multiple-outline",
          title: "没有地点",
          action: ctx.range.key !== "all" ? ui.button("查看全部时间", { kind: "soft", href: ctx.href("/stats/locations", { r: "all" }) }) : null
        })
      )
    );
    return;
  }

  const recentItems = d.recent.map((x) => ({
    href: drivesHref(ctx, { geofenceId: x.geofence_id, place: x.place }),
    icon: x.geofence_id != null ? "home-map-marker" : "map-marker",
    tone: x.geofence_id != null ? "accent" : null,
    title: x.address || UNKNOWN_PLACE,
    // 右边已经是「6小时前 / 9月13日」，副标题只补具体几点，不再重复日期
    sub: ui.fit([x.city, fmt.time(x.date)], { sep: true }),
    value: fmt.rel(x.date)
  }));

  const oneCountry = c.countries <= 1;
  const addressItems = d.addresses.map((x) => {
    // 名字：面板的写法（地名，没有就「路名 门牌」）；门牌也没有时用街道 / 城市兜底
    const name = (x.name || "").trim() || x.neighbourhood || x.city || UNKNOWN_PLACE;
    // 范围内只有一个国家时不写国家（每行都是「中国」，还把前面的街道挤没了）；名字就是街道 / 城市时不再重复它。
    // 窄屏上一行放不下时从后往前整项藏
    const where = [x.neighbourhood, x.city, x.state !== x.city ? x.state : null, oneCountry ? null : x.country].filter((v) => v && v !== name);
    const drives = drivesHref(ctx, { geofenceId: x.geofence_id, place: (x.name || "").trim() || null });
    const links = html`${drives ? html`<a class="pg-loc-link" href="${drives}">相关行程</a>` : ""}${
      x.geofence_id != null
        ? // 面板的 Geo-fences 表点名字去编辑收藏点；这里点收藏点标签去编辑
          html`<a class="pg-loc-fence" href="/geo-fences/${+x.geofence_id}/edit" title="编辑收藏点">${ui.pill(x.geofence, "accent", { icon: "home-map-marker" })}</a>`
        : Number.isFinite(+x.latitude) && Number.isFinite(+x.longitude)
          ? html`<a class="pg-loc-link" href="${`/geo-fences/new?lat=${+x.latitude}&lng=${+x.longitude}`}">设为收藏点</a>`
          : ""
    }`;
    return {
      icon: "map-marker",
      title: name,
      sub: where.length ? ui.fit(where, { sep: true }) : null,
      meta: links,
      value: x.arrivals ? `${fmt.int(x.arrivals)} 次` : x.charges ? `充电 ${fmt.int(x.charges)}` : "—",
      valueSub: x.arrivals ? (x.charges ? `到达 · 充电 ${fmt.int(x.charges)}` : "到达") : null
    };
  });

  // 右边的数和下面的地址列表一样是到达次数；「到达 375 次 · 充电 59 次」放副标题在 320 宽时会被截掉
  const geofenceItems = d.geofences.map((g) => ({
    href: drivesHref(ctx, { geofenceId: g.id }),
    icon: "home-map-marker",
    tone: "accent",
    title: g.name || "未命名收藏点",
    sub: g.last != null ? `最近到达 ${fmt.rel(g.last)}` : g.charges ? "这段时间没有到达记录" : "只从这里出发过",
    value: g.arrivals ? `${fmt.int(g.arrivals)} 次` : g.charges ? `充电 ${fmt.int(g.charges)}` : "—",
    valueSub: g.arrivals ? (g.charges ? `到达 · 充电 ${fmt.int(g.charges)}` : "到达") : null
  }));

  ui.render(
    ctx.root,
    html`
      ${ui.stats(
        [
          { label: "到过的地址", icon: "map-marker", value: c.addresses ?? 0, unit: "个" },
          { label: "城市", icon: "map-marker-multiple-outline", value: c.cities ?? 0, unit: "个" },
          { label: "省份", icon: "map-outline", value: c.states ?? 0, unit: "个" },
          { label: "国家和地区", icon: "earth", value: c.countries ?? 0, unit: "个" }
        ],
        { cols: 4 }
      )}

      <div class="tm-grid-2">
        ${ui.section("城市", ui.card(ranking(d.cities, "green", "这段时间没有城市记录。")), {
          sub: d.cities.length >= 10 ? "按到过的地址数，前 10 个" : "按到过的地址数"
        })}
        <div class="tm-stack pg-loc-col">
          ${ui.section("省份", ui.card(ranking(d.states, "amber", "这段时间没有省份记录。")), { sub: "按到过的地址数" })}
          ${ui.section(
            "收藏点",
            d.geofences.length
              ? ui.card(ui.list(geofenceItems), { pad: false })
              : ui.card(ui.empty("这段时间没到过收藏点。在 TeslaMate 里把家、公司设成收藏点，行程和充电就会显示这个名字。", { icon: "home-map-marker" })),
            { action: { href: "/geo-fences", label: "管理收藏点" } }
          )}
        </div>
      </div>

      <form class="pg-loc-search" role="search" id="pg-loc-search">
        <span class="tm-search">
          ${ui.icon("magnify")}
          <input class="tm-input" type="search" name="q" value="${text}" maxlength="60" placeholder="搜索地址，如 万达" enterkeyhint="search" autocomplete="off" aria-label="搜索地址">
        </span>
        <button type="submit" class="tm-btn is-primary">搜索</button>
      </form>
      ${text
        ? html`<p class="tm-note pg-loc-filter">「${text}」：最近到访 ${d.recent.length} 处，地址 ${d.addresses.length} 个 · <a href="${ctx.href("/stats/locations", { q: null })}">清除搜索</a></p>`
        : ""}

      <div class="tm-grid-2">
        ${ui.section(
          "最近到访",
          listBox("pg-loc-recent", recentItems, text ? "没有匹配的地点。" : "这段时间没有到达记录。"),
          { sub: "点一下看去过这里的行程" }
        )}
        ${ui.section("地址", listBox("pg-loc-addr", addressItems, text ? "没有匹配的地址。" : "这段时间没有地址。"), { sub: "按到达次数排序" })}
      </div>
    `
  );

  drawList(ctx.root.querySelector("#pg-loc-recent"), recentItems, "个地点");
  drawList(ctx.root.querySelector("#pg-loc-addr"), addressItems, "个地址");

  // 搜索：写进 URL（可以分享、后退），整页按新条件重查
  ctx.root.querySelector("#pg-loc-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = e.currentTarget.q.value.trim().slice(0, 60);
    ctx.setQuery({ q: v || null });
  });
}
