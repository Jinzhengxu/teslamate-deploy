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
 *   grafana  对应的 Grafana 面板 uid（字符串，或多个时用数组），页头「⋯」菜单里放「在 Grafana 中打开」
 *   grafanaVars(params)  打开 Grafana 时额外带的参数（详情页带上 id）
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
  { path: "/stats/", module: "home.js", title: "统计", group: null, icon: "chart-box-outline", grafana: "kOuP_Fggz", noCar: true },

  { path: "/stats/drives", module: "drives.js", title: "行程", group: "trips", icon: "road-variant", grafana: "Y8upc6ZRk", desc: "每一次出行的距离、能耗和路线" },
  {
    path: "/stats/drives/:id", module: "drive.js", title: "行程详情", group: null, icon: "road-variant", grafana: "zm7wN6Zgz",
    grafanaVars: (p) => ({ "var-drive_id": p.id }), parent: "/stats/drives"
  },
  { path: "/stats/charges", module: "charges.js", title: "充电", group: "trips", icon: "ev-station", grafana: "TSmNYvRRk", desc: "每次充了多少电、花了多少钱" },
  {
    path: "/stats/charges/:id", module: "charge.js", title: "充电详情", group: null, icon: "ev-station", grafana: "BHhxFeZRz",
    grafanaVars: (p) => ({ "var-charging_process_id": p.id }), parent: "/stats/charges"
  },
  { path: "/stats/trip", module: "trip.js", title: "旅程", group: "trips", icon: "map-marker-distance", grafana: "FkUpJpQZk", desc: "把一段时间里的行程和充电连起来看" },
  { path: "/stats/timeline", module: "timeline.js", title: "时间线", group: "trips", icon: "timeline-clock-outline", grafana: "SUBgwtigz", desc: "按时间顺序的行驶、充电、停车记录" },

  { path: "/stats/summary", module: "statistics.js", title: "按月汇总", group: "analysis", icon: "calendar-month-outline", grafana: "1EZnXszMk", desc: "按天、周、月、年汇总里程、能耗和充电" },
  { path: "/stats/driving", module: "drive-stats.js", title: "驾驶统计", group: "analysis", icon: "speedometer", grafana: "_7WkNSyWk", desc: "里程、速度分布和常去的地方" },
  { path: "/stats/efficiency", module: "efficiency.js", title: "能耗", group: "analysis", icon: "leaf", grafana: "fu4SiQgWz", desc: "能耗和温度、速度的关系" },
  { path: "/stats/charging", module: "charging-stats.js", title: "充电统计", group: "analysis", icon: "battery-charging-high", grafana: "-pkIkhmRz", desc: "充电量、费用、快慢充比例" },

  { path: "/stats/battery", module: "battery.js", title: "电池健康", group: "vehicle", icon: "battery-heart-variant", grafana: "jchmRiqUfXgTM", desc: "电池容量衰减和估算续航" },
  { path: "/stats/levels", module: "levels.js", title: "电量和里程", group: "vehicle", icon: "chart-timeline-variant", grafana: ["WopVO_mgz", "NjtMTFggz"], desc: "电量变化曲线和总里程增长" },
  { path: "/stats/range", module: "projected-range.js", title: "续航变化", group: "vehicle", icon: "gauge", grafana: "riqUfXgRz", desc: "满电续航随时间的变化" },
  { path: "/stats/vampire", module: "vampire.js", title: "待机掉电", group: "vehicle", icon: "sleep", grafana: "zhHx2Fggk", desc: "停车时悄悄掉了多少电" },
  { path: "/stats/states", module: "states.js", title: "状态", group: "vehicle", icon: "list-status", grafana: "xo4BNRkZz", desc: "在线、休眠、行驶各占多少时间" },
  { path: "/stats/updates", module: "updates.js", title: "软件更新", group: "vehicle", icon: "update", grafana: "IiC07mgWz", desc: "车机软件版本和更新间隔" },

  { path: "/stats/visited", module: "visited.js", title: "足迹", group: "places", icon: "map-outline", grafana: "RG_DxSmgk", desc: "开车去过的地方，画在地图上" },
  { path: "/stats/locations", module: "locations.js", title: "地点", group: "places", icon: "map-marker-multiple-outline", grafana: "ZzhF-aRWz", desc: "常去的城市、地址和收藏点" }
];

// Grafana 原版面板的中文名（页头「更多」菜单里「在 Grafana 中打开「…」」用）：TeslaMate 导航里原来的 19 个面板 + 荷兰税务报表
export const GRAFANA_DASHBOARDS = [
  { uid: "kOuP_Fggz", title: "概览", en: "Overview" },
  { uid: "Y8upc6ZRk", title: "行程", en: "Drives" },
  { uid: "TSmNYvRRk", title: "充电", en: "Charges" },
  { uid: "-pkIkhmRz", title: "充电统计", en: "Charging Stats" },
  { uid: "jchmRiqUfXgTM", title: "电池健康", en: "Battery Health" },
  { uid: "1EZnXszMk", title: "按月汇总", en: "Statistics" },
  { uid: "_7WkNSyWk", title: "驾驶统计", en: "Drive Stats" },
  { uid: "fu4SiQgWz", title: "能耗", en: "Efficiency" },
  { uid: "zhHx2Fggk", title: "待机掉电", en: "Vampire Drain" },
  { uid: "RG_DxSmgk", title: "足迹", en: "Visited" },
  { uid: "FkUpJpQZk", title: "旅程", en: "Trip" },
  { uid: "SUBgwtigz", title: "时间线", en: "Timeline" },
  { uid: "WopVO_mgz", title: "电量", en: "Charge Level" },
  { uid: "NjtMTFggz", title: "里程", en: "Mileage" },
  { uid: "riqUfXgRz", title: "续航变化", en: "Projected Range" },
  { uid: "xo4BNRkZz", title: "状态", en: "States" },
  { uid: "ZzhF-aRWz", title: "地点", en: "Locations" },
  { uid: "IiC07mgWz", title: "软件更新", en: "Updates" },
  { uid: "jchmDbInfo", title: "数据库信息", en: "Database Information" },
  { uid: "lBIoQIggk", title: "荷兰税务报表", en: "Drives - Dutch Tax" }
];

export function dashboardTitle(uid) {
  const d = GRAFANA_DASHBOARDS.find((x) => x.uid === uid);
  return d ? d.title : uid;
}

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
