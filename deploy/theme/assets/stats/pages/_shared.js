/*
 * 各页面共用的 SQL 片段。
 *
 * 地点名称：有地理围栏（家、公司）就用围栏名，否则用地址。g、a 是 SQL 里 geofences、addresses 表的别名。
 *   placeSql      短名字，列表行、标题用：地址自己的名字 → 路名门牌 → 街道 → 区县 → 城市
 *   placeFullSql  带城市，详情页用；和 Grafana 面板的写法一样，只是中文路名和门牌之间不加空格
 * 两个都可能是 NULL（没有反查到地址），页面自己显示「未知地点」。
 */

export function placeSql(g, a) {
  return `COALESCE(${g}.name, ${a}.name, NULLIF(CONCAT(${a}.road, ${a}.house_number), ''), ${a}.neighbourhood, ${a}.county, ${a}.city)`;
}

export function placeFullSql(g, a) {
  return `COALESCE(${g}.name, NULLIF(CONCAT_WS(', ', COALESCE(${a}.name, NULLIF(CONCAT(${a}.road, ${a}.house_number), '')), ${a}.city), ''))`;
}

export const UNKNOWN_PLACE = "未知地点";
