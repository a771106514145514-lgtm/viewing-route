/* 帶看路線（手機版）—— 整條路線都在瀏覽器裡算，不需要伺服器。

   物件資料是 Mac 上那支程式發布上來的 data.json（座標已經先查好放在裡面）。
   算車程用 OSRM、查地址用 Nominatim，兩個都免金鑰、都允許跨網域直接呼叫。 */

const OSRM = "https://router.project-osrm.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const DETOUR = 1.35;          // 直線距離換算實際路程
const CITY_SPEED = 32;        // 市區平均時速（公里）
const MAX_STOPS_PER_LINK = 10;
const PICKED_KEY = "daikan.picked";
const GEO_KEY = "daikan.geo";

const $ = (id) => document.getElementById(id);
const state = { rows: [], byCase: {}, picked: [], plan: null, map: null, layer: null, branch: "" };

const escapeHtml = (t) => String(t ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (row) => row.price_text || (row.price ? row.price + "萬" : "");

/* 案名點下去開物調。那個網址要登入吉富後台才打得開。 */
const caseLink = (row, text) => (row && row.survey_url
  ? `<a class="case" href="${escapeHtml(row.survey_url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`
  : escapeHtml(text));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 同一家店在後台會拆成「業一／業二」兩個名字，以店為單位就要把它們併起來 */
const storeOf = (row) => (row.branch || "").replace(/\s*業[一二三四五六七八九十\d]+\s*$/, "").trim();

/* 分店按鈕上只放「哪一家」，品牌跟「加盟店」三個字省掉才排得下 */
const shortStore = (name) => (name || "")
  .replace(/^(永慶不動產|永慶房屋|有巢氏房屋|有巢氏|永義房屋|台慶不動產|台慶房屋)/, "")
  .replace(/加盟店$/, "").trim() || name;

const FILTER_KEYS = ["f-city", "f-district", "f-rooms"];

let toastTimer = null;
function toast(text) {
  const box = $("toast");
  box.textContent = text;
  box.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("on"), 2800);
}

/* ------------------------------------------------------------------ 載入資料 */
async function boot() {
  let data = { stops: [], updated: "", count: 0 };
  try {
    const resp = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
    data = await resp.json();
  } catch (err) {
    $("info").textContent = "讀不到物件資料";
    toast("讀不到 data.json，請在 Mac 上重新發布一次");
  }
  state.rows = data.stops || [];
  state.byCase = {};
  state.rows.forEach((row) => { state.byCase[row.case_id] = row; });
  $("info").textContent = state.rows.length
    ? `${state.rows.length} 筆・${data.updated || ""}`
    : "目前沒有公開資料";

  state.picked = JSON.parse(localStorage.getItem(PICKED_KEY) || "[]")
    .filter((id) => state.byCase[id]);

  state.rows.forEach((row) => { row.store = storeOf(row); });
  fillCities();
  refreshDistricts();
  fillBranches();
  restoreFilters();
  renderPool();
  renderPicked();
}

/* ------------------------------------------------------------------ 篩選選單 */
function counted(values, head) {
  return `<option value="">${head}</option>` + values
    .map(([value, n]) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}（${n}）</option>`)
    .join("");
}

function tally(rows, key) {
  const counts = new Map();
  rows.forEach((row) => {
    const value = row[key];
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()];
}

function fillCities() {
  const values = tally(state.rows, "city").sort((a, b) => b[1] - a[1]);
  $("f-city").innerHTML = counted(values, "全部縣市");
}

function refreshDistricts() {
  // 行政區跟著已選的縣市走
  const city = $("f-city").value;
  const rows = city ? state.rows.filter((r) => r.city === city) : state.rows;
  const values = tally(rows, "district").sort((a, b) => b[1] - a[1]);
  const keep = $("f-district").value;
  $("f-district").innerHTML = counted(values, "全部行政區");
  $("f-district").value = values.some(([v]) => v === keep) ? keep : "";
}

function fillBranches() {
  // 以店為單位的下拉選單：件數多的排前面，件數跟著已選的縣市走，
  // 不然「選了店卻只剩幾筆」會看不懂。
  const city = $("f-city").value;
  const rows = city ? state.rows.filter((r) => r.city === city) : state.rows;
  const values = tally(rows, "store").sort((a, b) => b[1] - a[1]);
  if (state.branch && !values.some(([v]) => v === state.branch)) state.branch = "";
  $("f-branch").innerHTML = counted(values, `全部分店（${rows.length}）`);
  $("f-branch").value = state.branch;
}

function pickStore(name) {
  // 清單上點店名＝只看那家店，點同一家第二次就取消
  state.branch = state.branch === name ? "" : name;
  localStorage.setItem("daikan.f-branch", state.branch);
  $("f-branch").value = state.branch;
  renderPool();
  $("pool-list").scrollTop = 0;
}

$("f-branch").addEventListener("change", () => {
  state.branch = $("f-branch").value;
  localStorage.setItem("daikan.f-branch", state.branch);
  renderPool();
  $("pool-list").scrollTop = 0;
});

function restoreFilters() {
  // 縣市要先套用，行政區與分店的選項才是對的
  const saved = (id) => localStorage.getItem("daikan." + id) || "";
  const apply = (id) => {
    const value = saved(id);
    const select = $(id);
    if (value && [...select.options].some((o) => o.value === value)) select.value = value;
  };
  apply("f-city");
  state.branch = saved("f-branch");
  refreshDistricts();
  fillBranches();          // 會把 state.branch 套回下拉選單
  apply("f-district");
  apply("f-rooms");
}

function rememberFilters() {
  FILTER_KEYS.forEach((id) => localStorage.setItem("daikan." + id, $(id).value));
}

/* ------------------------------------------------------------------ 挑物件 */
function filtered() {
  const q = $("f-q").value.trim().toLowerCase();
  const city = $("f-city").value;
  const district = $("f-district").value;
  const rooms = $("f-rooms").value;
  const min = parseFloat($("f-min").value);
  const max = parseFloat($("f-max").value);
  return state.rows.filter((row) => {
    if (city && row.city !== city) return false;
    if (district && row.district !== district) return false;
    if (state.branch && row.store !== state.branch) return false;
    if (rooms) {
      const n = parseInt(row.rooms, 10) || 0;
      if (rooms === "4" ? n < 4 : n !== parseInt(rooms, 10)) return false;
    }
    if (!Number.isNaN(min) && !(row.price >= min)) return false;
    if (!Number.isNaN(max) && !(row.price <= max)) return false;
    if (q) {
      const hay = [row.title, row.address, row.full_address, row.case_id].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const LIMIT = 120;

function renderPool() {
  const rows = filtered();
  $("pool-count").textContent = `符合 ${rows.length} 筆`;
  const html = rows.slice(0, LIMIT).map((row) => {
    const on = state.picked.includes(row.case_id);
    const bits = [row.property_type, row.rooms, row.ping ? `${row.ping}坪` : "", row.floor]
      .filter(Boolean).join("・");
    return `<div class="item ${on ? "on" : ""}" data-case="${escapeHtml(row.case_id)}">
      <div class="grow">
        <div class="title">${on ? "✓ " : ""}${caseLink(row, row.title || row.case_id)}</div>
        <div class="meta">${escapeHtml(row.full_address || row.address || "沒有地址")}</div>
        <div class="meta"><span class="tag">${escapeHtml(row.case_id)}</span>${escapeHtml(bits)}</div>
        ${row.store ? `<div class="meta"><span class="tag store" data-store="${escapeHtml(row.store)}"
            >🏢 ${escapeHtml(row.store)}</span></div>` : ""}
      </div>
      <div class="price">${escapeHtml(money(row))}</div>
    </div>`;
  }).join("");
  const more = rows.length > LIMIT
    ? `<div class="empty">還有 ${rows.length - LIMIT} 筆沒顯示，縮小一下條件。</div>` : "";
  $("pool-list").innerHTML = html ? html + more
    : `<div class="empty">沒有符合的物件。</div>`;
}

function togglePick(caseId) {
  const index = state.picked.indexOf(caseId);
  if (index >= 0) state.picked.splice(index, 1);
  else state.picked.push(caseId);
  localStorage.setItem(PICKED_KEY, JSON.stringify(state.picked));
  renderPool();
  renderPicked();
}

function renderPicked() {
  $("trip-count").textContent = state.picked.length ? `${state.picked.length} 間` : "";
  $("bar-count").textContent = state.picked.length ? `已選 ${state.picked.length} 間` : "還沒選";
  const list = $("picked");
  if (!state.picked.length) {
    list.innerHTML = `<li class="empty">上面點幾間加進來，再按「幫我排順路」。</li>`;
    return;
  }
  list.innerHTML = state.picked.map((caseId, index) => {
    const row = state.byCase[caseId] || { case_id: caseId, title: caseId };
    const address = row.full_address || row.address || "沒有地址";
    return `<li>
      <span class="seq">${index + 1}</span>
      <span class="grow">
        <span style="font-weight:600">${caseLink(row, row.title || caseId)}</span>
        <span class="addr">${escapeHtml(address)}</span>
      </span>
      <span style="display:flex;gap:4px">
        <button class="tiny ghost" data-up="${index}">↑</button>
        <button class="tiny ghost" data-down="${index}">↓</button>
        <button class="tiny ghost" data-drop="${escapeHtml(caseId)}">✕</button>
      </span>
    </li>`;
  }).join("");
}

/* ------------------------------------------------------------------ 查地址 */
function geoCache() {
  try { return JSON.parse(localStorage.getItem(GEO_KEY) || "{}"); } catch (err) { return {}; }
}
function geoRemember(key, value) {
  const cache = geoCache();
  cache[key] = value;
  try { localStorage.setItem(GEO_KEY, JSON.stringify(cache)); } catch (err) { /* 滿了就算了 */ }
}

const AREA_RE = /^(.{2,3}?[市縣](?:.{1,4}?區|.{1,4}?[鄉鎮]|.{1,3}?市))/;

function areaOf(address) {
  const m = /^(.{2,3}?[市縣])(.{1,4}?區|.{1,4}?[鄉鎮]|.{1,3}?市)/.exec(address || "");
  if (m) return [m[1], m[2]];
  const c = /^(.{2,3}?[市縣])/.exec(address || "");
  return c ? [c[1], ""] : ["", ""];
}

function variants(address) {
  const addr = (address || "").replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "");
  if (!addr) return [];
  const out = [["門牌", addr.replace(/\d+樓(之\d+)?$|之\d+$/, "")]];
  let m = /^(.*?\d+巷(?:\d+弄)?)/.exec(addr);
  if (m) out.push(["巷", m[1]]);
  m = /^(.*?(?:路|街|大道|道)(?:[一二三四五六七八九十]+段)?)/.exec(addr);
  if (m) out.push(["路", m[1]]);
  m = AREA_RE.exec(addr);
  if (m) out.push(["區", m[1]]);
  const city = areaOf(addr)[0];
  if (city && !out.some(([level]) => level === "區")) out.push(["區", city]);
  const seen = new Set();
  return out.filter(([, query]) => query && !seen.has(query) && seen.add(query));
}

function levelOf(query) {
  if (query.includes("號")) return "門牌";
  if (query.includes("巷") || query.includes("弄")) return "巷";
  if (/[路街道]/.test(query)) return "路";
  return "區";
}

let lastAsk = 0;

async function geocode(address) {
  const key = (address || "").replace(/\s+/g, "");
  if (!key) return null;
  const cache = geoCache();
  if (key in cache) return cache[key];

  const want = areaOf(key).filter(Boolean);
  for (const [level, query] of variants(key)) {
    const gap = 1100 - (Date.now() - lastAsk);
    if (gap > 0) await sleep(gap);        // Nominatim 每秒最多一次
    lastAsk = Date.now();
    let rows = [];
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=8&countrycodes=tw&q=${encodeURIComponent(query)}`;
      rows = await (await fetch(url)).json();
    } catch (err) { rows = []; }
    const tokens = level === "區" ? want.slice(0, 1) : want;
    const hit = (rows || []).find((row) => tokens.every((t) => (row.display_name || "").includes(t)));
    if (hit) {
      const point = { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), precision: levelOf(query) };
      geoRemember(key, point);
      return point;
    }
  }
  geoRemember(key, null);
  return null;
}

/* ------------------------------------------------------------------ 算路線 */
function haversine(a, b) {
  const rad = (x) => x * Math.PI / 180;
  const [lat1, lon1, lat2, lon2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const coordString = (points) => points.map((p) => `${p.lon},${p.lat}`).join(";");

function straightMatrix(points) {
  const n = points.length;
  const dur = [...Array(n)].map(() => Array(n).fill(0));
  const dist = [...Array(n)].map(() => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const metres = haversine([points[i].lat, points[i].lon], [points[j].lat, points[j].lon]) * DETOUR;
      dist[i][j] = metres;
      dur[i][j] = metres / (CITY_SPEED * 1000 / 3600);
    }
  }
  return { dur, dist, source: "straight" };
}

async function matrix(points) {
  try {
    const url = `${OSRM}/table/v1/driving/${coordString(points)}?annotations=duration,distance`;
    const data = await (await fetch(url)).json();
    if (data.code === "Ok" && data.durations && data.durations.length === points.length) {
      return { dur: data.durations, dist: data.distances || data.durations, source: "osrm" };
    }
  } catch (err) { /* 沒網路就用直線估 */ }
  return straightMatrix(points);
}

async function legsAndShape(points) {
  if (points.length < 2) return { legs: [], shape: [], source: "none" };
  try {
    const url = `${OSRM}/route/v1/driving/${coordString(points)}?overview=simplified&geometries=geojson`;
    const data = await (await fetch(url)).json();
    if (data.code === "Ok" && data.routes && data.routes[0]) {
      const route = data.routes[0];
      return {
        legs: route.legs.map((l) => ({ seconds: l.duration || 0, metres: l.distance || 0 })),
        shape: (route.geometry.coordinates || []).map((c) => [c[1], c[0]]),
        source: "osrm",
      };
    }
  } catch (err) { /* 同上 */ }
  const legs = points.slice(1).map((b, i) => {
    const metres = haversine([points[i].lat, points[i].lon], [b.lat, b.lon]) * DETOUR;
    return { metres, seconds: metres / (CITY_SPEED * 1000 / 3600) };
  });
  return { legs, shape: points.map((p) => [p.lat, p.lon]), source: "straight" };
}

function cost(order, dur, cyclic) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i += 1) total += dur[order[i]][order[i + 1]];
  if (cyclic && order.length > 1) total += dur[order[order.length - 1]][order[0]];
  return total;
}

function improve(order, dur, cyclic, lockLast) {
  const n = order.length;
  const hi = lockLast ? n - 1 : n;
  let improved = true;
  while (improved) {
    improved = false;
    let base = cost(order, dur, cyclic);
    for (let i = 1; i < hi; i += 1) {
      for (let j = i + 1; j < hi; j += 1) {
        const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        const value = cost(cand, dur, cyclic);
        if (value < base - 0.5) { order = cand; base = value; improved = true; }
      }
    }
    for (let i = 1; i < hi; i += 1) {
      for (let j = 1; j < hi; j += 1) {
        if (i === j) continue;
        const moved = order.slice(0, i).concat(order.slice(i + 1));
        const cand = moved.slice(0, j).concat([order[i]], moved.slice(j));
        if (cand.length !== n) continue;
        const value = cost(cand, dur, cyclic);
        if (value < base - 0.5) { order = cand; base = value; improved = true; }
      }
    }
  }
  return order;
}

function optimize(dur, n, startIndex, endIndex, cyclic) {
  const fixed = new Set([startIndex, endIndex].filter((x) => x !== null && x !== undefined));
  const free = [...Array(n).keys()].filter((i) => !fixed.has(i));
  if (!free.length) return [startIndex, endIndex].filter((x) => x !== null && x !== undefined);

  const starts = startIndex !== null && startIndex !== undefined ? [startIndex] : free;
  let best = null;
  let bestCost = Infinity;
  starts.forEach((s) => {
    const rest = free.filter((i) => i !== s);
    let order = [s];
    while (rest.length) {
      const here = order[order.length - 1];
      let pick = 0;
      rest.forEach((j, index) => { if (dur[here][j] < dur[here][rest[pick]]) pick = index; });
      order.push(rest.splice(pick, 1)[0]);
    }
    if (endIndex !== null && endIndex !== undefined) order.push(endIndex);
    order = improve(order, dur, cyclic, endIndex !== null && endIndex !== undefined);
    const value = cost(order, dur, cyclic);
    if (value < bestCost) { best = order; bestCost = value; }
  });
  return best || [];
}

function gmapsStop(point) {
  const address = (point.full_address || point.address || "").trim();
  if (address && (address.includes("號") || point.lat == null)) return address;
  if (point.lat != null) return `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
  return address;
}

function googleLinks(points) {
  const stops = points.map(gmapsStop);
  if (stops.length < 2) return [];
  const links = [];
  let index = 0;
  let part = 1;
  while (index < stops.length - 1) {
    const chunk = stops.slice(index, index + MAX_STOPS_PER_LINK);
    const params = new URLSearchParams({
      api: "1", travelmode: "driving", origin: chunk[0], destination: chunk[chunk.length - 1],
    });
    if (chunk.length > 2) params.set("waypoints", chunk.slice(1, -1).join("|"));
    links.push({ part, url: "https://www.google.com/maps/dir/?" + params.toString() });
    index += MAX_STOPS_PER_LINK - 1;
    part += 1;
  }
  return links;
}

const hhmm = (minutes) => {
  const total = Math.round(minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text || "").trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

async function buildPlan(keepOrder) {
  const startAddress = $("s-start").value.trim();
  const backToStart = $("s-back").checked;
  const dwell = parseInt($("s-dwell").value, 10) || 0;
  const depart = $("s-depart").value;

  const stops = state.picked.map((caseId) => Object.assign({ kind: "case" }, state.byCase[caseId]));
  const warnings = [];

  let start = null;
  if (startAddress) {
    start = { kind: "start", name: "出發點", address: startAddress, full_address: startAddress };
    if (state.herePoint && startAddress === state.hereLabel) {
      start.lat = state.herePoint.lat;
      start.lon = state.herePoint.lon;
      start.precision = "手動";
    }
  }

  const points = (start ? [start] : []).concat(stops);
  for (const point of points) {
    if (point.lat != null) continue;
    const hit = await geocode(point.full_address || point.address || "");
    if (hit) Object.assign(point, hit);
  }
  const missing = points.filter((p) => p.lat == null);
  missing.forEach((p) => warnings.push(`找不到「${p.address || p.name}」的位置，這一站沒有排進去。`));
  const located = points.filter((p) => p.lat != null);
  if (located.length < 2) return { ok: false, error: "至少要有兩個查得到位置的地點。", warnings };

  let order;
  let matrixSource = "";
  if (keepOrder) {
    order = [...Array(located.length).keys()];
  } else {
    const table = await matrix(located);
    matrixSource = table.source;
    const startIndex = start && located[0] === start ? 0 : null;
    order = optimize(table.dur, located.length, startIndex, null, backToStart);
  }

  let ordered = order.map((i) => located[i]);
  if (backToStart) {
    const home = start || ordered[0];
    ordered = ordered.concat([Object.assign({}, home, { kind: "return", name: `回到${home.name || "起點"}` })]);
  }

  const { legs, shape, source } = await legsAndShape(ordered);
  if (source === "straight" || matrixSource === "straight") {
    warnings.push("連不上路況服務，這次是用直線距離估的，順序大致對但時間會不準。");
  }
  const rough = ordered.filter((s) => s.precision === "區" || !s.precision).map((s) => s.name);
  if (rough.length) {
    warnings.push("這幾間只查到行政區的位置，順序可能不準：" + rough.slice(0, 4).join("、"));
  }

  let clock = minutesOf(depart);
  let seconds = 0;
  let metres = 0;
  let caseSeq = 0;
  ordered.forEach((stop, index) => {
    const leg = index ? legs[index - 1] : null;
    if (stop.kind === "case") { caseSeq += 1; stop.case_seq = caseSeq; }
    if (leg) {
      stop.leg_minutes = Math.round(leg.seconds / 60);
      stop.leg_km = Math.round(leg.metres / 100) / 10;
      seconds += leg.seconds;
      metres += leg.metres;
      if (clock != null) clock += leg.seconds / 60;
    } else {
      stop.leg_minutes = null;
    }
    if (clock != null) {
      stop.arrive = hhmm(clock);
      if (stop.kind === "case") { clock += dwell; stop.leave = hhmm(clock); }
    }
  });

  const cases = ordered.filter((s) => s.kind === "case");
  const driveMinutes = Math.round(seconds / 60);
  return {
    ok: true, stops: ordered, warnings, shape,
    totals: {
      stops: cases.length, drive_minutes: driveMinutes,
      km: Math.round(metres / 100) / 10, whole_minutes: driveMinutes + cases.length * dwell,
      finish: clock != null ? (ordered[ordered.length - 1].leave || ordered[ordered.length - 1].arrive) : "",
    },
    links: googleLinks(ordered),
    text: shareText(ordered, depart),
  };
}

/* LINE 只能傳純文字，按不到「按鈕」，所以給業務的版本是傳一個連結：
   點進去是 trip.html，那一頁每一間都有「物調」「導航」按鈕。
   物調網址也一起寫在文字裡，當作連結打不開時的備援。 */
const openLine = (text) =>
  window.open("https://line.me/R/share?text=" + encodeURIComponent(text), "_blank");

function tripUrl(result, depart) {
  const ids = result.stops.filter((s) => s.kind === "case" && s.case_id).map((s) => s.case_id);
  if (!ids.length) return "";
  const base = location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, "") + "trip.html";
  return `${base}#c=${ids.join(",")}${depart ? "&t=" + depart : ""}`;
}

function agentText(result, depart) {
  const cases = result.stops.filter((s) => s.kind === "case");
  const lines = [`帶看路線（給業務）${cases.length} 間${depart ? "・" + depart + " 出發" : ""}`];
  cases.forEach((stop, index) => {
    lines.push(`${index + 1}. ${stop.title || stop.name}（${stop.case_id}）`);
    lines.push(`   ${stop.full_address || stop.address || ""}`);
    if (stop.survey_url) lines.push(`   物調 ${stop.survey_url}`);
  });
  const url = tripUrl(result, depart);
  if (url) lines.push(`整份清單（物調＋導航按鈕）：${url}`);
  return lines.join("\n");
}

function shareText(ordered, depart) {
  const lines = [depart ? `帶看路線（${depart} 出發）` : "帶看路線"];
  let n = 0;
  ordered.forEach((stop) => {
    if (stop.kind !== "case") {
      lines.push(`— ${stop.name}：${stop.full_address || stop.address || ""}`);
      return;
    }
    n += 1;
    lines.push(`${n}. ${stop.arrive ? stop.arrive + " " : ""}${stop.title || stop.name}`);
    const detail = [money(stop), stop.rooms, stop.ping ? `${stop.ping}坪` : ""].filter(Boolean).join(" ");
    lines.push(`   ${stop.full_address || stop.address || ""}${detail ? "｜" + detail : ""}`);
  });
  return lines.join("\n");
}

/* ------------------------------------------------------------------ 畫結果 */
function renderResult(result) {
  const totals = result.totals;
  const body = result.stops.map((stop, index) => {
    const leg = stop.leg_minutes != null
      ? `<div class="leg">↓ 車程 ${stop.leg_minutes} 分・${stop.leg_km} 公里</div>` : "";
    const anchor = stop.kind !== "case";
    const badge = anchor ? (stop.kind === "start" ? "起" : "終") : stop.case_seq;
    const detail = anchor ? "" : [money(stop), stop.rooms,
      stop.ping ? `${stop.ping}坪` : "", stop.property_type].filter(Boolean).join("・");
    const address = stop.full_address || stop.address || "";
    return `${index ? leg : ""}
      <div class="stop ${anchor ? "anchor" : ""}">
        <span class="badge">${escapeHtml(badge)}</span>
        <span class="grow" style="flex:1;min-width:0">
          <div><span class="when">${escapeHtml(stop.arrive || "")}</span>
            <b>${caseLink(stop, stop.title || stop.name)}</b>
            ${stop.leave && !anchor ? `<span class="note">（看到 ${escapeHtml(stop.leave)}）</span>` : ""}</div>
          <div class="note">${escapeHtml(address)}</div>
          ${detail ? `<div class="note">${escapeHtml(detail)}</div>` : ""}
        </span>
        ${address ? `<button class="tiny ghost" data-one="${escapeHtml(address)}">導航</button>` : ""}
      </div>`;
  }).join("");

  const links = result.links.map((link) => `<button class="primary" data-url="${escapeHtml(link.url)}">
      🗺️ ${result.links.length > 1 ? `Google 地圖 第${link.part}段` : "用 Google 地圖開路線"}</button>`).join("");
  const warns = result.warnings.map((w) => `<div class="warn">${escapeHtml(w)}</div>`).join("");

  $("result").innerHTML = `
    <div class="totals">
      <div><span>看幾間</span><b>${totals.stops}</b></div>
      <div><span>純車程</span><b>${totals.drive_minutes} 分</b></div>
      <div><span>總里程</span><b>${totals.km} 公里</b></div>
      <div><span>含看屋全程</span><b>${Math.floor(totals.whole_minutes / 60)} 小時 ${totals.whole_minutes % 60} 分</b></div>
      ${totals.finish ? `<div><span>結束</span><b>${escapeHtml(totals.finish)}</b></div>` : ""}
    </div>
    ${warns}
    <div>${body}</div>
    <div class="actions">
      ${links}
      <button id="btn-copy">📋 複製清單</button>
      <button id="btn-line">💬 傳給客戶</button>
      <button id="btn-line-agent">💬 傳給業務</button>
    </div>`;

  $("result").querySelectorAll("[data-url]").forEach((button) => {
    button.addEventListener("click", () => window.open(button.dataset.url, "_blank"));
  });
  $("result").querySelectorAll("[data-one]").forEach((button) => {
    button.addEventListener("click", () => window.open(
      "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination="
      + encodeURIComponent(button.dataset.one), "_blank"));
  });
  $("btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(result.text);
      toast("清單複製好了");
    } catch (err) { toast("這個瀏覽器不給複製，長按上面的文字自己選"); }
  });
  $("btn-line").addEventListener("click", () => {
    openLine(result.text + (result.links[0] ? `\n${result.links[0].url}` : ""));
  });
  $("btn-line-agent").addEventListener("click", () => {
    openLine(agentText(result, $("s-depart").value));
  });

  drawMap(result);
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function drawMap(result) {
  const box = $("map");
  if (typeof L === "undefined") { box.hidden = true; return; }
  const points = result.stops.filter((s) => s.lat != null);
  if (points.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  if (!state.map) {
    state.map = L.map(box).setView([points[0].lat, points[0].lon], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(state.map);
  }
  if (state.layer) state.layer.remove();
  state.layer = L.layerGroup().addTo(state.map);
  const shape = (result.shape || []).length > 1 ? result.shape : points.map((s) => [s.lat, s.lon]);
  L.polyline(shape, { color: "#2f8f66", weight: 4, opacity: .85 }).addTo(state.layer);
  points.forEach((stop) => {
    const label = stop.kind === "case" ? stop.case_seq : (stop.kind === "start" ? "起" : "終");
    L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: "", iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div style="width:26px;height:26px;border-radius:50%;background:#2f8f66;color:#fff;
          display:grid;place-items:center;font:700 13px -apple-system,sans-serif;
          box-shadow:0 1px 4px rgba(0,0,0,.4)">${label}</div>`,
      }),
    }).addTo(state.layer).bindPopup(
      `<b>${escapeHtml(stop.title || stop.name)}</b><br>${escapeHtml(stop.full_address || stop.address || "")}`);
  });
  state.map.fitBounds(L.latLngBounds(shape), { padding: [24, 24] });
  setTimeout(() => state.map.invalidateSize(), 80);
}

/* ------------------------------------------------------------------ 綁定 */
async function plan(keepOrder) {
  if (!state.picked.length) return toast("先挑幾間物件。");
  const buttons = [$("btn-plan"), $("btn-keep")];
  buttons.forEach((b) => { b.disabled = true; });
  $("btn-plan").textContent = "算路線中…";
  try {
    const result = await buildPlan(keepOrder);
    if (!result.ok) { toast(result.error); return; }
    state.plan = result;
    if (!keepOrder) {
      state.picked = result.stops.filter((s) => s.kind === "case").map((s) => s.case_id);
      localStorage.setItem(PICKED_KEY, JSON.stringify(state.picked));
      renderPicked();
      renderPool();
    }
    renderResult(result);
  } catch (err) {
    toast("算不出來：" + err.message);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    $("btn-plan").textContent = "🚗 幫我排順路";
  }
}

$("pool-list").addEventListener("click", (event) => {
  if (event.target.closest("a")) return;      // 點案名是要開物調
  const store = event.target.closest("[data-store]");
  if (store) return pickStore(store.dataset.store);   // 點店名＝只看那家店
  const item = event.target.closest(".item");
  if (item) togglePick(item.dataset.case);
});

$("picked").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const { up, down, drop } = button.dataset;
  if (drop !== undefined) return togglePick(drop);
  const index = parseInt(up ?? down, 10);
  const to = up !== undefined ? index - 1 : index + 1;
  if (to < 0 || to >= state.picked.length) return;
  const moved = state.picked.splice(index, 1)[0];
  state.picked.splice(to, 0, moved);
  localStorage.setItem(PICKED_KEY, JSON.stringify(state.picked));
  renderPicked();
});

$("btn-empty").addEventListener("click", () => {
  state.picked = [];
  localStorage.setItem(PICKED_KEY, "[]");
  $("result").innerHTML = "";
  $("map").hidden = true;
  renderPool();
  renderPicked();
});

$("btn-here").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("這個瀏覽器不支援定位。");
  toast("定位中…");
  navigator.geolocation.getCurrentPosition((pos) => {
    state.herePoint = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    state.hereLabel = "我現在的位置";
    $("s-start").value = state.hereLabel;
    toast("起點設成你現在的位置了");
  }, () => toast("拿不到位置，請允許定位權限。"), { enableHighAccuracy: true, timeout: 10000 });
});

$("btn-plan").addEventListener("click", () => plan(false));
$("btn-keep").addEventListener("click", () => plan(true));
["f-q", "f-min", "f-max"].forEach((id) => $(id).addEventListener("input", renderPool));
["f-district", "f-rooms"].forEach((id) => $(id).addEventListener("change", () => {
  rememberFilters();
  renderPool();
}));
$("f-city").addEventListener("change", () => {
  refreshDistricts();
  fillBranches();
  rememberFilters();
  renderPool();
});
$("btn-clear-filter").addEventListener("click", () => {
  ["f-q", "f-min", "f-max"].forEach((id) => { $(id).value = ""; });
  FILTER_KEYS.forEach((id) => { $(id).value = ""; });
  state.branch = "";
  localStorage.setItem("daikan.f-branch", "");
  refreshDistricts();
  fillBranches();
  rememberFilters();
  renderPool();
});

["s-start", "s-depart", "s-dwell", "s-back"].forEach((id) => {
  const el = $(id);
  const saved = localStorage.getItem("daikan." + id);
  if (saved !== null) { if (el.type === "checkbox") el.checked = saved === "1"; else el.value = saved; }
  el.addEventListener("change", () => {
    localStorage.setItem("daikan." + id, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value);
  });
});

boot();
