/*
 * TeslaMate 换肤 —— 配合 theme.css 的一点点脚本，由 deploy/theme/nginx/teslamate-theme.conf 注入。
 *
 *   1. <meta name="theme-color"> 跟随亮 / 暗主题（手机浏览器地址栏的颜色）
 *   2. 手机底栏：补一个「主页」标签、标出当前页、「控制台」改成弹出面板
 *   3. 车辆卡片：从页面文字里读出电量、充电上限和状态，写成 data-* / CSS 变量给样式用
 *   4. 页面切换时顶部的细进度条
 *
 * 车辆卡片由 LiveView 实时刷新，刷新时会把元素上服务端没渲染的属性抹掉。这里只往每辆车的
 * LiveView 容器（div#car_N）上写；它平时不被自己的刷新改动，但外层 LiveView 连接时会被清一次，
 * 所以用 MutationObserver 盯着：卡片内容变了、或者我们写的属性被抹了，都重算一遍。
 * 任何一步出错都只影响对应的小功能，不影响 TeslaMate 本身。
 */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  root.classList.add("tm-js");

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        if (window.console) console.warn("[tm-theme]", e);
      }
    };
  }

  // TeslaMate 自己的翻译（priv/gettext/*/default.po 里 "Home" 的译文），保持和面包屑一致
  var HOME_LABEL = {
    ca: "Inici", da: "Hjem", de: "Home", es: "Inicio", fi: "Koti", fr: "Accueil",
    hu: "Kezdőlap", it: "Home", ja: "ホーム", ko: "홈", nb: "Hjem", nl: "Home",
    sv: "Hem", th: "บ้าน", tr: "Anasayfa", uk: "Додому", "zh-hans": "主页", "zh-hant": "首頁"
  };

  // 新建收藏点还没起名时，大标题用这个代替 TeslaMate 的「…」（用词和它自己的「新建」「收藏点」一致）
  var NEW_GEOFENCE_LABEL = {
    de: "Neuer Geo-Fence", fr: "Nouveau géorepérage", ja: "ジオフェンスを作成",
    "zh-hans": "新建收藏点", "zh-hant": "新增收藏地點"
  };

  function localized(dict, fallback) {
    var lang = (root.getAttribute("lang") || "en").toLowerCase();
    return dict[lang] || dict[lang.split("-")[0]] || fallback;
  }

  function homeLabel() {
    return localized(HOME_LABEL, "Home");
  }

  // ---------------------------------------------------------------- 1. theme-color

  var syncThemeColor = safe(function () {
    var color = getComputedStyle(root).getPropertyValue("--tm-chrome").trim();
    if (!color) return;
    var metas = doc.querySelectorAll('meta[name="theme-color"]');
    if (!metas.length) {
      var m = doc.createElement("meta");
      m.name = "theme-color";
      doc.head.appendChild(m);
      metas = [m];
    }
    for (var i = 0; i < metas.length; i++) {
      if (metas[i].getAttribute("content") !== color) metas[i].setAttribute("content", color);
    }
  });

  new MutationObserver(syncThemeColor).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });
  syncThemeColor();

  // ---------------------------------------------------------------- 2. 导航

  var mobileNav = window.matchMedia("(max-width: 1023px)");

  var setupNav = safe(function () {
    var end = doc.querySelector("#navbar .navbar-end");
    if (!end || end.querySelector(".tm-home")) return;

    var brand = doc.querySelector(".navbar-brand > a.navbar-item");
    var home = doc.createElement("a");
    home.className = "navbar-item tm-home";
    home.href = (brand && brand.getAttribute("href")) || "/";
    home.innerHTML =
      '<span class="icon"><i class="mdi mdi-car-side"></i></span><span></span>';
    home.lastChild.textContent = homeLabel();
    end.insertBefore(home, end.firstChild);

    var dropdown = end.querySelector(".navbar-item.has-dropdown");
    if (dropdown) {
      var toggle = dropdown.querySelector(".navbar-link");
      var menu = dropdown.querySelector(".navbar-dropdown");
      // 原版这个链接没有 href，键盘既 Tab 不到也按不动
      toggle.tabIndex = 0;
      toggle.setAttribute("role", "button");
      if (!menu.id) menu.id = "tm-dashboards";
      toggle.setAttribute("aria-controls", menu.id);
      toggle.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle.click();
        }
      });
      // 桌面上鼠标点一下别让它拿到焦点：Bulma 的 :focus-within 会让下拉框一直开着，鼠标移开也不收
      toggle.addEventListener("mousedown", function (e) {
        if (mobileNav.matches) return;
        e.preventDefault();
        var active = doc.activeElement;
        if (active && active !== toggle && dropdown.contains(active)) active.blur();
      });
      toggle.addEventListener("click", function (e) {
        if (!mobileNav.matches) return;
        e.preventDefault();
        e.stopPropagation();
        setSheet(dropdown, !dropdown.classList.contains("tm-open"));
      });
      menu.addEventListener("click", function (e) {
        if (e.target.closest("a")) setSheet(dropdown, false);
      });
      doc.addEventListener("click", function (e) {
        if (dropdown.classList.contains("tm-open") && !dropdown.contains(e.target)) {
          setSheet(dropdown, false);
        }
      });
      doc.addEventListener("keydown", function (e) {
        if (e.key !== "Escape" || !dropdown.classList.contains("tm-open")) return;
        var hadFocus = dropdown.contains(doc.activeElement);
        setSheet(dropdown, false);
        if (hadFocus) toggle.focus();
      });
      // aria-expanded 只在手机面板模式下有意义；桌面上下拉框由 Bulma 的悬停 / 焦点控制，不报状态免得报错
      var onBreakpoint = function () {
        setSheet(dropdown, false);
        if (!mobileNav.matches) toggle.removeAttribute("aria-expanded");
      };
      onBreakpoint();
      if (mobileNav.addEventListener) mobileNav.addEventListener("change", onBreakpoint);
      else if (mobileNav.addListener) mobileNav.addListener(onBreakpoint);
    }

    markActive();
  });

  function setSheet(dropdown, open) {
    dropdown.classList.toggle("tm-open", open);
    root.classList.toggle("tm-sheet-open", open);
    var toggle = dropdown.querySelector(".navbar-link");
    if (toggle && mobileNav.matches) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  var markActive = safe(function () {
    var items = doc.querySelectorAll("#navbar .navbar-end > a.navbar-item[href]");
    var path = location.pathname.replace(/\/+$/, "") || "/";
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var href = (a.getAttribute("href") || "").replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
      var active = href === "/" ? path === "/" : path === href || path.indexOf(href + "/") === 0;
      a.classList.toggle("tm-active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  });

  // ---------------------------------------------------------------- 3. 车辆卡片

  // 「当前状态」那一格的文字就是 TeslaMate 翻译过的状态名（summary.ex 的 translate_state），
  // 按它判断最准。下面是 priv/gettext 里各语言的译文；认不出来时再退回看其它行的特征。
  var STATE_LABELS = {
    charging: ["charging", "cargando", "carregant", "en charge", "in carica", "laddat", "ladet",
      "lataa", "lädt", "opladen", "oplader", "töltés", "şarj oluyor", "заряджається",
      "กำลังชาร์จ", "充电中", "充電中", "충전"],
    driving: ["driving", "ajossa", "conduciendo", "conduint", "conduite", "fährt", "in movimento",
      "kjører", "kört", "kører", "rijden", "sürüş", "vezetés", "подорожує", "กำลังขับรถ",
      "行驶中", "運転中", "駕駛中", "주행"],
    updating: ["updating", "actualitzant", "actualizando", "aggiornamento in corso", "bijwerken",
      "frissítés alatt", "güncelleniyor", "installiert update", "mise à jour en cours",
      "opdaterer", "oppdaterer", "päivittää", "uppdaterat", "оновлюється", "กำลังอัปเดท",
      "アップデート中", "更新中", "업데이트"],
    suspended: ["falling asleep", "elalvás folyamatban", "entrando en reposo", "entrant en repòs",
      "gått ner i vila", "menossa lepotilaan", "s'endort", "schläft ein", "sospensione in corso",
      "uykuya dalıyor", "valt in slaap", "ved at falde i søvn", "засинає",
      "กำลังเข้าสู่การหลับ", "スリープ中", "进入休眠中", "進入休眠中", "절전 중"],
    online: ["online", "en ligne", "en línea", "en línia", "in linea", "yhteydessä", "çevrimiçi",
      "онлайн", "ออนไลน์", "オンライン", "在线", "線上", "온라인"],
    // 休眠 / 离线 / 不可用：不上色
    idle: ["asleep", "offline", "unavailable", "alvó", "dvale", "en reposo", "en repòs", "endormie",
      "lepotilassa", "schläft", "slaapt", "sospesa", "sover", "uykuda", "vilat", "спить",
      "หลับอยู่", "スリープ", "休眠", "已休眠", "절전", "hors ligne", "non raggiungibile",
      "offline-tilassa", "sense connexió", "sin conexión", "çevrimdışı", "офлайн", "ออฟไลน์",
      "オフライン", "离线", "離線中", "오프라인", "ei saatavilla", "ikke tilgjengelig",
      "ikke tilgængelig", "indisponible", "inte tillgänglig", "mevcut değil", "nem elérhető",
      "nicht verfügbar", "no disponible", "non disponibile", "onbeschikbaar", "недоступно",
      "ไม่พร้อมใช้งาน", "不可用", "利用不可", "無法使用", "사용불가"]
  };
  // 长的先比：「スリープ中」（正在休眠）要先于「スリープ」（已休眠）命中
  var LABELS = [];
  Object.keys(STATE_LABELS).forEach(function (k) {
    STATE_LABELS[k].forEach(function (label) {
      LABELS.push([label, k]);
    });
  });
  LABELS.sort(function (a, b) {
    return b[0].length - a[0].length;
  });

  // 返回状态名；休眠等不上色的返回 null；认不出来返回 undefined
  function stateFromLabel(card) {
    var cell = card.querySelector("tbody > tr:first-child > td:last-child");
    var text = cell ? cell.textContent.replace(/\s+/g, " ").trim().toLowerCase() : "";
    for (var i = 0; i < LABELS.length; i++) {
      if (text.indexOf(LABELS[i][0]) === 0) return LABELS[i][1] === "idle" ? null : LABELS[i][1];
    }
    return undefined;
  }

  var NUM = /(\d+(?:[.,]\d+)?)/;
  // 数值后面的单位不翻译，可以跨语言认出是哪一行
  var POWER = /^\s*-?\d+(?:[.,]\d+)?[\s ]*kW\s*$/;
  var SPEED = /^\s*\d+(?:[.,]\d+)?[\s ]*(?:km\/h|mph)\s*$/;
  var PERCENT = /^\s*(\d{1,3})\s*%\s*$/;

  function setData(el, name, value) {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function setVar(el, name, value) {
    if (value == null) {
      if (el.style.getPropertyValue(name)) el.style.removeProperty(name);
    } else if (el.style.getPropertyValue(name).trim() !== value) {
      el.style.setProperty(name, value);
    }
  }

  var decorateCar = safe(function (card) {
    var host = card.parentElement;
    if (!host) return;

    var socEl = card.querySelector("tbody .has-tooltip-right-desktop");
    var socRow = socEl && socEl.closest("tr");
    var soc = null;
    if (socEl) {
      var m = socEl.textContent.match(NUM);
      if (m) soc = Math.max(0, Math.min(100, parseFloat(m[1].replace(",", "."))));
    }

    var limit = null;
    var state = stateFromLabel(card);
    // 「取消休眠」按钮只在 :suspended 时出现，比文字可靠（挪威语里「已休眠」「正在休眠」是同一个词）
    if (!state && card.querySelector('[phx-click="resume_logging"]')) state = "suspended";
    var known = state !== undefined;
    if (!known) state = null;
    var rows = card.querySelectorAll("tbody > tr");
    for (var i = 0; i < rows.length; i++) {
      var cell = rows[i].lastElementChild;
      if (!cell) continue;
      var text = cell.textContent;
      if (rows[i] !== socRow && i > 0) {
        var p = text.match(PERCENT);
        if (p && limit == null) limit = Math.min(100, parseInt(p[1], 10));
      }
      if (known) continue;
      if (POWER.test(text)) state = "charging";
      else if (!state && SPEED.test(text)) state = "driving";
    }
    if (!known) {
      if (!state && card.querySelector('[phx-hook="LocalDateTime"]')) state = "charging";
      if (!state && card.querySelector('[phx-click="resume_logging"]')) state = "suspended";
      if (!state && card.querySelector('[phx-click="suspend_logging"]')) state = "online";
    }

    setData(host, "data-tm-state", state);
    setData(host, "data-tm-soc-level", soc == null ? null : soc <= 10 ? "low" : soc <= 20 ? "mid" : "ok");
    setVar(host, "--tm-soc", soc == null ? null : String(soc));
    setVar(host, "--tm-limit", limit == null ? null : String(limit));
    host.__tmSig = hostSig(host);
  });

  // 我们写在 div#car_N 上的东西的快照；LiveView 抹掉它们时和快照对不上，就知道要补写
  function hostSig(h) {
    return [
      h.getAttribute("data-tm-state"),
      h.getAttribute("data-tm-soc-level"),
      h.style.getPropertyValue("--tm-soc"),
      h.style.getPropertyValue("--tm-limit")
    ].join("|");
  }

  var markUntitled = safe(function () {
    var a = doc.querySelector(".breadcrumb li.is-active a");
    var text = a ? a.textContent.trim() : "";
    var untitled = text === "\u2026" || text === "...";
    root.classList.toggle("tm-untitled", untitled);
    if (untitled) {
      root.style.setProperty("--tm-untitled-label", JSON.stringify(localized(NEW_GEOFENCE_LABEL, "New Geo-Fence")));
    }
  });

  var scheduled = false;
  function decorateAll() {
    scheduled = false;
    var cards = doc.querySelectorAll(".car.card");
    for (var i = 0; i < cards.length; i++) decorateCar(cards[i]);
    markUntitled();
  }

  // MutationObserver 的回调在浏览器绘制之前跑，LiveView 刷新后不会闪一帧旧样式
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(decorateAll);
  }

  var observeMain = safe(function () {
    var main = doc.querySelector("main");
    if (!main) return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (!t) continue;
        // 地图拖动、瓦片加载的变动很密，和卡片数据无关
        if (t.closest(".leaflet-container")) continue;
        if (r.type === "attributes") {
          // div#car_N 上的属性：是我们自己写的就忽略（免得循环），被 LiveView 抹掉了就补写
          if (t.__tmSig !== undefined) {
            if (hostSig(t) !== t.__tmSig) {
              schedule();
              return;
            }
            continue;
          }
          if (!t.closest(".car")) continue;
        }
        schedule();
        return;
      }
    }).observe(main, { childList: true, subtree: true, characterData: true, attributes: true });
    decorateAll();
  });

  // ---------------------------------------------------------------- 4. 页面切换进度条

  var setupProgress = safe(function () {
    var bar = doc.createElement("div");
    bar.id = "tm-progress";
    doc.body.appendChild(bar);
    var showTimer = null;
    var hideTimer = null;
    // 页面内的小操作（比如切换开关）不显示，只在换页时显示
    function isPage(e) {
      var kind = e.detail && e.detail.kind;
      return !kind || kind === "redirect" || kind === "patch" || kind === "initial";
    }
    window.addEventListener("phx:page-loading-start", function (e) {
      if (!isPage(e)) return;
      clearTimeout(hideTimer);
      hideTimer = null;
      // 一次 live 跳转会成对地发出 redirect 和 initial 两组事件，只起一次
      if (showTimer || bar.className === "is-active") return;
      showTimer = setTimeout(function () {
        showTimer = null;
        // 先不带过渡地归零，否则会从上一次的 100% 往回缩
        bar.style.transition = "none";
        bar.className = "";
        void bar.offsetWidth;
        bar.style.transition = "";
        bar.className = "is-active";
      }, 120);
    });
    window.addEventListener("phx:page-loading-stop", function (e) {
      if (isPage(e)) {
        clearTimeout(showTimer);
        showTimer = null;
        if (bar.className === "is-active") {
          bar.className = "is-done";
          clearTimeout(hideTimer);
          hideTimer = setTimeout(function () {
            hideTimer = null;
            bar.className = "";
          }, 600);
        }
      }
      markActive();
      syncThemeColor();
    });
  });

  window.addEventListener("popstate", markActive);

  function init() {
    setupNav();
    observeMain();
    setupProgress();
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})();
