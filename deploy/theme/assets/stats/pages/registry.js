/*
 * 路由表（核心负责维护，页面代理不要改）。
 *
 * 每项：
 *   path     路由（:id 这类是参数）
 *   module   pages/ 下的模块文件
 *   title    页头标题（和模块里的 title 一致；模块加载前先用它显示）
 *   group    统计首页上的分组（null：不在首页列出，比如详情页、首页自己）
 *   desc     首页入口下面的一行说明
 *   icon     图标名（core/icons.js）
 *   parent   返回按钮的上级页面（没有浏览历史时用）
 *   noCar    没有车辆数据时也能打开
 */

export const GROUPS = [
  { id: "trips", title: "行程与充电", tone: "accent" },
  { id: "analysis", title: "统计分析", tone: "violet" },
  { id: "vehicle", title: "车辆与电池", tone: "green" },
  { id: "places", title: "地图与地点", tone: "amber" }
];

export const ROUTES = [
  { path: "/stats/", module: "home.js", title: "统计", group: null, icon: "chart-box-outline", noCar: true },

  { path: "/stats/drives", module: "drives.js", title: "行程", group: "trips", icon: "road-variant", desc: "每一次出行的距离、能耗和路线" },
  { path: "/stats/drives/:id", module: "drive.js", title: "行程详情", group: null, icon: "road-variant", parent: "/stats/drives" },
  { path: "/stats/charges", module: "charges.js", title: "充电", group: "trips", icon: "ev-station", desc: "每次充了多少电、花了多少钱" },
  { path: "/stats/charges/:id", module: "charge.js", title: "充电详情", group: null, icon: "ev-station", parent: "/stats/charges" },
  { path: "/stats/trip", module: "trip.js", title: "旅程", group: "trips", icon: "map-marker-distance", desc: "把一段时间里的行程和充电连起来看" },
  { path: "/stats/timeline", module: "timeline.js", title: "时间线", group: "trips", icon: "timeline-clock-outline", desc: "按时间顺序的行驶、充电、停车记录" },

  { path: "/stats/summary", module: "statistics.js", title: "按月汇总", group: "analysis", icon: "calendar-month-outline", desc: "按天、周、月、年汇总里程、能耗和充电" },
  { path: "/stats/driving", module: "drive-stats.js", title: "驾驶统计", group: "analysis", icon: "speedometer", desc: "里程、速度分布和常去的地方" },
  { path: "/stats/efficiency", module: "efficiency.js", title: "能耗", group: "analysis", icon: "leaf", desc: "能耗和温度、速度的关系" },
  { path: "/stats/charging", module: "charging-stats.js", title: "充电统计", group: "analysis", icon: "battery-charging-high", desc: "充电量、费用、快慢充比例" },

  { path: "/stats/battery", module: "battery.js", title: "电池健康", group: "vehicle", icon: "battery-heart-variant", desc: "电池容量衰减和估算续航" },
  { path: "/stats/levels", module: "levels.js", title: "电量和里程", group: "vehicle", icon: "chart-timeline-variant", desc: "电量变化曲线和总里程增长" },
  { path: "/stats/range", module: "projected-range.js", title: "续航变化", group: "vehicle", icon: "gauge", desc: "满电续航随时间的变化" },
  { path: "/stats/vampire", module: "vampire.js", title: "待机掉电", group: "vehicle", icon: "sleep", desc: "停车时悄悄掉了多少电" },
  { path: "/stats/states", module: "states.js", title: "状态", group: "vehicle", icon: "list-status", desc: "在线、休眠、行驶各占多少时间" },
  { path: "/stats/updates", module: "updates.js", title: "软件更新", group: "vehicle", icon: "update", desc: "车机软件版本和更新间隔" },

  { path: "/stats/visited", module: "visited.js", title: "足迹", group: "places", icon: "map-outline", desc: "开车去过的地方，画在地图上" },
  { path: "/stats/locations", module: "locations.js", title: "地点", group: "places", icon: "map-marker-multiple-outline", desc: "常去的城市、地址和收藏点" }
];

// 编译路由：/stats/drives/:id → 正则
const compiled = ROUTES.map((r) => {
  const names = [];
  const re = r.path
    .replace(/\/$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, n) => {
      names.push(n);
      return "([^/]+)";
    });
  return { route: r, re: new RegExp(`^${re}/?$`), names };
});

// pathname → { route, params } | null
export function match(pathname) {
  let p = pathname;
  try {
    p = decodeURI(pathname);
  } catch {
    /* 保持原样 */
  }
  for (const c of compiled) {
    const m = c.re.exec(p);
    if (!m) continue;
    const params = {};
    c.names.forEach((n, i) => (params[n] = m[i + 1]));
    return { route: c.route, params };
  }
  return null;
}

export function byPath(path) {
  return ROUTES.find((r) => r.path === path) || null;
}

// 首页用：按分组列出入口
export function entries() {
  return GROUPS.map((g) => ({ ...g, items: ROUTES.filter((r) => r.group === g.id) })).filter((g) => g.items.length);
}
