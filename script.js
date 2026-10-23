const OBLASTS_URL = "https://raw.githubusercontent.com/slawomirmatuszak/ukrainian_geodata/master/regiony.geojson";
const RAIONS_URL = "https://raw.githubusercontent.com/slawomirmatuszak/ukrainian_geodata/master/rayony.geojson";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const SETTLEMENTS_URL = "https://raw.githubusercontent.com/bnotezz/ua-settlements/main/assets/data/settlements.json";
const WEATHER_CODES = {
  0:"Ясно",1:"Переважно ясно",2:"Мінлива хмарність",3:"Хмарно",45:"Туман",48:"Туман",
  51:"Мряка",53:"Мряка",55:"Сильна мряка",56:"Крижана мряка",57:"Крижана мряка",
  61:"Невеликий дощ",63:"Дощ",65:"Сильний дощ",66:"Крижаний дощ",67:"Крижаний дощ",
  71:"Невеликий сніг",73:"Сніг",75:"Сильний сніг",77:"Снігові зерна",80:"Короткочасний дощ",
  81:"Зливи",82:"Сильні зливи",85:"Снігові заряди",86:"Сильні снігові заряди",95:"Гроза",96:"Гроза з градом",99:"Сильна гроза з градом"
};
let map;
let oblastFeatures = [];
let districtItems = [];
let selectedOblast = null;
let hoveredItem = null;
let hoveredLatLng = null;
let requestSequence = 0;
let oblastLabelMarkers = [];
let panelRequestSequence = 0;
let currentPanelItem = null;
const FAVORITES_KEY = "wezeraapp-favorite-districts-v1";
const weatherCache = new Map();
const weatherPending = new Map();
const districtTemperatures = new WeakMap();
const featureNames = new WeakMap();
let settlementsPromise = null;
let settlementsData = null;
let fullMapBounds = null;
let userLocationMarker = null;
const districtTooltip = () => document.getElementById("district-tooltip");

function propsOf(feature) { return feature?.properties || {}; }
function normalize(value) {
  return String(value ?? "").toLocaleLowerCase("uk-UA").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[’'`]/g, "").replace(/[^a-zа-яіїєґ0-9]/g, "");
}
function getName(feature, kind = "district") {
  if (featureNames.has(feature)) return featureNames.get(feature);
  const p = propsOf(feature);
  const keys = kind === "oblast"
    ? ["name_uk","NAME_1","name","NAME","shapeName","region_name","oblast_name","admin1Name","NAME_UK"]
    : ["name_uk","raion_name","raionName","admin2Name","NAME_2","NAME_3","name_2","name_3","shapeName","NAME_UK","name","NAME","name_1"];
  let value;
  for (const key of keys) if (typeof p[key] === "string" && p[key].trim()) { value = p[key].trim(); break; }
  if (!value) {
    const pattern = kind === "oblast" ? /oblast|region|admin1|name/i : /raion|district|admin2|name|shape/i;
    value = Object.entries(p).find(([key, v]) => pattern.test(key) && typeof v === "string" && v.trim() && !/^ukraine$/i.test(v.trim()))?.[1];
  }
  if (!value) value = Object.values(p).find(v => typeof v === "string" && v.trim() && !/^ukraine$/i.test(v.trim()));
  value = value ? String(value).trim() : (kind === "oblast" ? "Область" : "Район без назви");
  featureNames.set(feature, value);
  return value;
}
function centerOf(feature) {
  try { const b = L.geoJSON(feature).getBounds(); if (b.isValid()) { const c = b.getCenter(); return [c.lat, c.lng]; } } catch (_) {}
  return null;
}
const EXCLUDED_OBLAST_NAMES = [
  "севастополь", "севатополь", "sevastopol",
  // Донецька область повернута на карту; Крим, Луганська, Запорізька та Херсонська також залишаються.
];
function isExcludedOblastName(value) {
  const name = normalize(value);
  return EXCLUDED_OBLAST_NAMES.some(alias => name === normalize(alias) || name.startsWith(normalize(alias)) || name.includes(normalize(alias)));
}
function districtParentName(feature) {
  const p = propsOf(feature);
  const keys = ["oblast", "oblast_name", "region", "region_name", "adm1_name", "NAME_1", "name_1", "admin1Name", "parent_name", "raion_oblast", "oblastName"];
  for (const key of keys) if (typeof p[key] === "string" && p[key].trim()) return p[key].trim();
  return "";
}
function isInsideExcludedOblast(feature, excludedOblasts) {
  const center = centerOf(feature);
  if (!center) return false;
  return excludedOblasts.some(oblast => pointInGeometry(center, oblast.geometry));
}
function pointInRing(point, ring) {
  const x = point[1], y = point[0]; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(point, rings) {
  if (!rings?.length || !pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(point, rings[i])) return false;
  return true;
}
function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some(poly => pointInPolygon(point, poly));
  return false;
}
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates || [];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).flat(1);
  return [];
}
function districtSamples(feature) {
  const rings = ringsOf(feature.geometry).filter(r => r.length > 3);
  const samples = [];
  for (const ring of rings) {
    const stride = Math.max(1, Math.floor(ring.length / 30));
    for (let i = 0; i < ring.length; i += stride) {
      const [lng, lat] = ring[i];
      if (Number.isFinite(lat) && Number.isFinite(lng)) samples.push([lat, lng]);
    }
  }
  const center = centerOf(feature);
  if (center) samples.push(center);
  return samples;
}
function findOblastForDistrict(feature) {
  const p = propsOf(feature);
  const parentKeys = ["oblast", "oblast_name", "region", "region_name", "adm1_name", "NAME_1", "name_1", "admin1Name", "parent_name"];
  const parentValue = parentKeys.map(k => p[k]).find(v => typeof v === "string" && v.trim());
  if (parentValue) {
    const wanted = normalize(parentValue);
    const byName = oblastFeatures.find(o => normalize(getName(o, "oblast")) === wanted || normalize(getName(o, "oblast")).includes(wanted) || wanted.includes(normalize(getName(o, "oblast"))));
    if (byName) return byName;
  }
  const samples = districtSamples(feature);
  if (!samples.length) return null;
  let best = null, bestScore = -1;
  for (const oblast of oblastFeatures) {
    let score = 0;
    for (const point of samples) if (pointInGeometry(point, oblast.geometry)) score++;
    if (score > bestScore) { best = oblast; bestScore = score; }
  }
  // The majority-of-boundary-points test is resilient to a district's bounding-box centre falling outside its polygon.
  return bestScore > 0 ? best : null;
}
function isRedOblast(feature) {
  const name = normalize(getName(feature, "oblast"));
  return ["запорізька", "запорожская", "zaporizhzhia", "zaporizhya", "zaporozhye", "херсонська", "херсонская", "kherson", "луганська", "луганская", "luhansk", "lugansk", "донецька", "донецкая", "donetsk", "крим", "crimea", "ар крим", "автономна республіка крим", "автономная республика крым"]
    .some(alias => name.includes(normalize(alias)));
}
function temperatureColor(temp) {
  // Колір від прохолодного блакитного до темно-червоного за поточною температурою.
  const stops = [
    [-15, [104, 177, 255]], [-5, [130, 196, 255]], [0, [151, 211, 255]],
    [10, [190, 231, 255]], [20, [190, 20, 35]], [30, [92, 0, 18]]
  ];
  const t = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], temp));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * f)).join(",")})`;
    }
  }
  return "#5c0012";
}
function baseStyle(feature) {
  const item = districtItems.find(entry => entry.feature === feature);
  const temp = item ? districtTemperatures.get(item) : null;
  // Якщо температура ще завантажується — залишаємо нейтральний колір.
  const fillColor = Number.isFinite(temp) ? temperatureColor(temp) : "#3b414d";
  return { color: "#252b35", weight: 0.9, opacity: 1, fillColor, fillOpacity: 1 };
}
function activeStyle(item) {
  const temp = districtTemperatures.get(item);
  return { color: "#fff", weight: 2.2, opacity: 1, fillColor: Number.isFinite(temp) ? temperatureColor(temp) : "#596273", fillOpacity: 1 };
}
function refreshStyles() {
  for (const item of districtItems) {
    item.layer.setStyle(item === hoveredItem ? activeStyle(item) : baseStyle(item.feature));
  }
}
async function loadDistrictTemperatureColors() {
  // Batch requests to avoid sending one weather request per district.
  const entries = districtItems.map(item => ({ item, center: centerOf(item.feature) })).filter(x => x.center);
  const batchSize = 40;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const params = new URLSearchParams({
      latitude: batch.map(x => x.center[0].toFixed(4)).join(","),
      longitude: batch.map(x => x.center[1].toFixed(4)).join(","),
      current: "temperature_2m", timezone: "Europe/Kyiv"
    });
    try {
      const response = await fetch(`${WEATHER_URL}?${params}`);
      if (!response.ok) throw new Error("Weather colors unavailable");
      const payload = await response.json();
      const results = Array.isArray(payload) ? payload : [payload];
      results.forEach((result, index) => {
        const temp = result?.current?.temperature_2m;
        if (Number.isFinite(temp) && batch[index]) districtTemperatures.set(batch[index].item, temp);
      });
      refreshStyles();
    } catch (error) {
      console.warn("Не вдалося оновити температурні кольори районів:", error);
    }
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function positionTooltip(latlng) {
  const el = districtTooltip();
  if (!el || !latlng) return;
  const point = map.latLngToContainerPoint(latlng);
  const mapRect = map.getContainer().getBoundingClientRect();
  const width = el.offsetWidth || 210;
  let left = point.x + 14, top = point.y - el.offsetHeight - 12;
  if (left + width > mapRect.width - 8) left = point.x - width - 14;
  if (top < 8) top = point.y + 14;
  el.style.left = `${Math.max(8, Math.min(left, mapRect.width - width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(top, mapRect.height - el.offsetHeight - 8))}px`;
}
function showTooltip(latlng, name, weather) {
  const el = districtTooltip();
  if (!el) return;
  // A single fixed DOM element prevents Leaflet from leaving multiple tooltip layers behind.
  el.innerHTML = `<strong>${escapeHtml(name)}</strong><div class="tooltip-weather">${weather}</div>`;
  el.hidden = false;
  positionTooltip(latlng);
}
function hideTooltip() { const el = districtTooltip(); if (el) el.hidden = true; }
function weatherKey(feature) {
  const c = centerOf(feature);
  return c ? `${c[0].toFixed(3)},${c[1].toFixed(3)}` : normalize(getName(feature));
}
async function loadWeather(feature) {
  const key = weatherKey(feature);
  if (weatherCache.has(key)) return weatherCache.get(key);
  if (weatherPending.has(key)) return weatherPending.get(key);
  const center = centerOf(feature);
  if (!center) return "Погода: невідомо";
  const params = new URLSearchParams({ latitude: String(center[0]), longitude: String(center[1]), current: "temperature_2m,weather_code,wind_speed_10m", timezone: "Europe/Kyiv" });
  const task = fetch(`${WEATHER_URL}?${params}`).then(r => { if (!r.ok) throw new Error("Weather request failed"); return r.json(); })
    .then(data => {
      const c = data.current;
      if (!c || !Number.isFinite(c.temperature_2m)) throw new Error("Weather missing");
      const condition = WEATHER_CODES[c.weather_code] || "невідомо";
      return `${escapeHtml(condition)} · ${Math.round(c.temperature_2m)}°C<br>Вітер: ${Number.isFinite(c.wind_speed_10m) ? Math.round(c.wind_speed_10m) + " км/год" : "невідомо"}`;
    }).catch(() => "Погода: невідомо").then(result => { weatherCache.set(key, result); weatherPending.delete(key); return result; });
  weatherPending.set(key, task);
  return task;
}
async function onDistrictEnter(item, latlng) {
  // A hover must work immediately: infer the active oblast from the district if none is selected,
  // or switch the active oblast when the pointer enters a district in another oblast.
  if (!item.oblast) item.oblast = findOblastForDistrict(item.feature);
  if (item.oblast) selectedOblast = item.oblast;
  hoveredItem = item;
  hoveredLatLng = latlng;
  refreshStyles();
  const seq = ++requestSequence;
  const name = getName(item.feature);
  showTooltip(latlng, name, "Завантажуємо погоду…");
  const weather = await loadWeather(item.feature);
  if (seq !== requestSequence || hoveredItem !== item) return;
  const el = districtTooltip();
  if (el && !el.hidden) showTooltip(hoveredLatLng || latlng, name, weather);
}
function bindDistrict(feature, layer) {
  const item = { feature, layer, oblast: null };
  districtItems.push(item);
  layer.on({
    mouseover: e => { void onDistrictEnter(item, e.latlng); },
    mousemove: e => {
      if (hoveredItem === item && !districtTooltip().hidden) {
        hoveredLatLng = e.latlng;
        positionTooltip(e.latlng);
      }
    },
    mouseout: () => {
      if (hoveredItem === item) {
        hoveredItem = null;
        hoveredLatLng = null;
        requestSequence++;
        hideTooltip();
        refreshStyles();
      }
    },
    click: e => {
      if (!item.oblast) item.oblast = findOblastForDistrict(feature);
      if (item.oblast) selectedOblast = item.oblast;
      hoveredItem = item;
      hoveredLatLng = e.latlng;
      refreshStyles();
      requestSequence++;
      hideTooltip();
      void openWeatherPanel(item);
    }
  });
}

function prettyDistrictName(feature) {
  let name = getName(feature, "district").replace(/район/ig, "район").trim();
  if (!/район/i.test(name)) name += " район";
  return name;
}
function formatOblastLabel(rawName) {
  let name = String(rawName || "Область").trim().replace(/^м\.\s*/i, "м. ");
  // Normalize source variants from GeoJSON (Ukrainian, Russian, English).
  name = name.replace(/\s*(область|обл\.|oblast|region)\s*$/i, "").trim();
  const key = name.toLocaleLowerCase("uk-UA").replace(/[’'`]/g, "").replace(/\s+/g, " ").trim();
  const names = {
    "винницкая":"Вінницька", "вінницька":"Вінницька", "vinnytsia":"Вінницька", "vinnitsa":"Вінницька", "vinnytska":"Вінницька",
    "волынская":"Волинська", "волинська":"Волинська", "volyn":"Волинська", "volynska":"Волинська",
    "днепропетровская":"Дніпропетровська", "дніпропетровська":"Дніпропетровська", "dnipropetrovsk":"Дніпропетровська", "dnipropetrovska":"Дніпропетровська", "dnepropetrovsk":"Дніпропетровська",
    "донецкая":"Донецька", "донецька":"Донецька", "donetsk":"Донецька", "donetska":"Донецька",
    "житомирская":"Житомирська", "житомирська":"Житомирська", "zhytomyr":"Житомирська", "zhytomyrska":"Житомирська",
    "закарпатская":"Закарпатська", "закарпатська":"Закарпатська", "zakarpattia":"Закарпатська", "zakarpatska":"Закарпатська", "transcarpathia":"Закарпатська",
    "запорожская":"Запорізька", "запорізька":"Запорізька", "zaporizhzhia":"Запорізька", "zaporizhzhya":"Запорізька", "zaporozhye":"Запорізька", "zaporizka":"Запорізька",
    "ивано франковская":"Івано-Франківська", "івано франківська":"Івано-Франківська", "івано-франківська":"Івано-Франківська", "ivano frankivsk":"Івано-Франківська", "ivano-frankivsk":"Івано-Франківська", "ivano frankivska":"Івано-Франківська",
    "киевская":"Київська", "київська":"Київська", "kyiv":"Київська", "kyivska":"Київська", "kiev":"Київська",
    "кировоградская":"Кіровоградська", "кіровоградська":"Кіровоградська", "kirovohrad":"Кіровоградська", "kirovohradska":"Кіровоградська", "kirovograd":"Кіровоградська",
    "луганская":"Луганська", "луганська":"Луганська", "luhansk":"Луганська", "luhanska":"Луганська", "lugansk":"Луганська",
    "львовская":"Львівська", "львівська":"Львівська", "lviv":"Львівська", "lvivska":"Львівська", "lvov":"Львівська",
    "николаевская":"Миколаївська", "миколаївська":"Миколаївська", "mykolaiv":"Миколаївська", "mykolaivska":"Миколаївська", "nikolaev":"Миколаївська",
    "одесская":"Одеська", "одеська":"Одеська", "odesa":"Одеська", "odesa oblast":"Одеська", "odeska":"Одеська", "odessa":"Одеська",
    "полтавская":"Полтавська", "полтавська":"Полтавська", "poltava":"Полтавська", "poltavska":"Полтавська",
    "ровенская":"Рівненська", "рівненська":"Рівненська", "rivne":"Рівненська", "rivnenska":"Рівненська", "rovno":"Рівненська",
    "сумская":"Сумська", "сумська":"Сумська", "sumy":"Сумська", "sumska":"Сумська",
    "тернопольская":"Тернопільська", "тернопільська":"Тернопільська", "ternopil":"Тернопільська", "ternopilska":"Тернопільська",
    "харьковская":"Харківська", "харківська":"Харківська", "kharkiv":"Харківська", "kharkivska":"Харківська", "kharkov":"Харківська",
    "херсонская":"Херсонська", "херсонська":"Херсонська", "kherson":"Херсонська", "khersonska":"Херсонська",
    "хмельницкая":"Хмельницька", "хмельницька":"Хмельницька", "khmelnytskyi":"Хмельницька", "khmelnytska":"Хмельницька", "khmelnitsky":"Хмельницька",
    "черкасская":"Черкаська", "черкаська":"Черкаська", "cherkasy":"Черкаська", "cherkaska":"Черкаська", "cherkassy":"Черкаська",
    "черниговская":"Чернігівська", "чернігівська":"Чернігівська", "chernihiv":"Чернігівська", "chernihivska":"Чернігівська", "chernigov":"Чернігівська",
    "черновицкая":"Чернівецька", "чернівецька":"Чернівецька", "chernivtsi":"Чернівецька", "chernivetska":"Чернівецька", "chernovtsy":"Чернівецька",
    "крым":"АР Крим", "крим":"АР Крим", "crimea":"АР Крим", "autonomous republic of crimea":"АР Крим", "автономна республіка крим":"АР Крим",
    "севастополь":"Севастополь", "sevastopol":"Севастополь"
  };
  if (names[key]) return names[key];
  // Preserve correct Ukrainian adjectival labels without duplicating suffixes.
  const ukrainian = name.replace(/\s+/g, " ").trim();
  if (/ська$|цька$|зька$|івська$|ївська$|ська$/i.test(ukrainian)) return ukrainian;
  return ukrainian || "Область";
}
function addOblastLabels() {
  const pane = map.createPane("oblastLabelsPane");
  pane.style.zIndex = 650;
  pane.style.pointerEvents = "none";
  oblastLabelMarkers.forEach(marker => map.removeLayer(marker));
  oblastLabelMarkers = [];
  for (const feature of oblastFeatures) {
    const center = centerOf(feature);
    if (!center) continue;
    const name = formatOblastLabel(getName(feature, "oblast"));
    const icon = L.divIcon({ className: "oblast-label-icon", html: `<div class="oblast-label">${escapeHtml(name)}</div>`, iconSize: [140, 22], iconAnchor: [70, 11] });
    const marker = L.marker(center, { icon, pane: "oblastLabelsPane", interactive: false, keyboard: false });
    marker.addTo(map);
    oblastLabelMarkers.push(marker);
  }
}
function formatDateUk(dateString) {
  try { return new Date(`${dateString}T12:00:00`).toLocaleDateString("uk-UA", { day: "numeric", month: "short" }); }
  catch (_) { return dateString; }
}
function weatherCondition(code) { return WEATHER_CODES[code] || "Невідомі умови"; }
async function fetchWeatherAt(lat, lon, includeHistory = true) {
  const params = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m", hourly: "temperature_2m,precipitation_probability,weather_code", forecast_hours: "24", daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max", forecast_days: "4", timezone: "Europe/Kyiv" });
  const forecastPromise = fetch(`${WEATHER_URL}?${params}`).then(r => { if (!r.ok) throw new Error("Forecast unavailable"); return r.json(); });
  let historyPromise = Promise.resolve(null);
  if (includeHistory) {
    const now = new Date();
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const hp = new URLSearchParams({ latitude: String(lat), longitude: String(lon), start_date: fmt(start), end_date: fmt(end), daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum", timezone: "Europe/Kyiv" });
    historyPromise = fetch(`https://archive-api.open-meteo.com/v1/archive?${hp}`).then(r => r.ok ? r.json() : null).catch(() => null);
  }
  const [forecast, history] = await Promise.all([forecastPromise, historyPromise]);
  return { forecast, history };
}
function formatUpdatedTime(value) {
  if (!value) return "час невідомий";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "час невідомий";
  return new Intl.DateTimeFormat("uk-UA", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Kyiv" }).format(date);
}
function readFavorites() { try { const v = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
function renderFavorites() {
  const host = document.getElementById("favorite-districts"); if (!host) return;
  const items = readFavorites(); host.innerHTML = items.map((x,i) => `<button class="favorite-chip" type="button" data-favorite-index="${i}">${escapeHtml(x.name)} ×</button>`).join("");
  host.querySelectorAll("[data-favorite-index]").forEach(btn => btn.addEventListener("click", () => {
    const item = readFavorites()[Number(btn.dataset.favoriteIndex)]; if (!item) return;
    const found = districtItems.find(d => normalize(prettyDistrictName(d.feature)) === normalize(item.name));
    if (found) { const c = centerOf(found.feature); if (c) map.setView(c, Math.max(map.getZoom(), 7)); void openWeatherPanel(found); }
  }));
}
function addSafetyLinks(name) {
  return `<section class="safety-section"><h2>Офіційні повідомлення та допомога</h2><p class="muted">Перевіряйте актуальність повідомлень у першоджерелах. На цій карті немає підтвердженого автоматичного статусу проїзду доріг.</p><div class="safety-links"><a href="https://dsns.gov.ua/" target="_blank" rel="noopener noreferrer">ДСНС України ↗</a><a href="https://www.facebook.com/MNS.GOV.UA/" target="_blank" rel="noopener noreferrer">Офіційні повідомлення ДСНС ↗</a><a href="https://restoration.gov.ua/" target="_blank" rel="noopener noreferrer">Агентство відновлення · дороги ↗</a><a href="https://nezlamnist.gov.ua/" target="_blank" rel="noopener noreferrer">Пункти незламності ↗</a><a href="https://ukraine.ua/" target="_blank" rel="noopener noreferrer">Офіційний портал України ↗</a></div><p class="small-note">Для екстреної допомоги в Україні: 112 (єдиний номер, де доступний), 101 — рятувальники, 102 — поліція, 103 — швидка.</p></section>`;
}
function renderWeatherData(data, target, prefix = "") {
  if (!data?.forecast?.current) { target.innerHTML = `<p class="muted">Погода: невідомо. Спробуйте ще раз пізніше.</p>`; return; }
  const c = data.forecast.current, d = data.forecast.daily || {};
  const temp = Number.isFinite(c.temperature_2m) ? `${Math.round(c.temperature_2m)}°C` : "невідомо";
  const wind = Number.isFinite(c.wind_speed_10m) ? `${Math.round(c.wind_speed_10m)} км/год` : "невідомо";
  const feels = Number.isFinite(c.apparent_temperature) ? `${Math.round(c.apparent_temperature)}°C` : "невідомо";
  const humidity = Number.isFinite(c.relative_humidity_2m) ? `${Math.round(c.relative_humidity_2m)}%` : "невідомо";
  let html = `<section class="weather-current"><div class="temperature">${temp}</div><div class="condition">${escapeHtml(weatherCondition(c.weather_code))}</div><div class="weather-stats"><div class="weather-stat"><span>Відчувається як</span><strong>${feels}</strong></div><div class="weather-stat"><span>Вітер</span><strong>${wind}</strong></div><div class="weather-stat"><span>Вологість</span><strong>${humidity}</strong></div><div class="weather-stat"><span>Дані оновлено</span><strong>${escapeHtml(formatUpdatedTime(c.time))}</strong></div></div></section>`;
  html += `<h2>Прогноз на 4 дні</h2><div class="history-list">`;
  if (Array.isArray(d.time)) d.time.forEach((day, i) => { html += `<div class="history-row"><div><div>${escapeHtml(formatDateUk(day))}</div><div class="date">${escapeHtml(weatherCondition(d.weather_code?.[i]))}</div></div><strong>${Number.isFinite(d.temperature_2m_max?.[i]) ? Math.round(d.temperature_2m_max[i]) : "—"}° / ${Number.isFinite(d.temperature_2m_min?.[i]) ? Math.round(d.temperature_2m_min[i]) : "—"}°</strong></div>`; });
  const hourly = data.forecast.hourly || {};
  html += `</div><h2>Погодинний прогноз</h2><div class="hourly-list">`;
  let shownHours = 0;
  if (Array.isArray(hourly.time)) {
    const now = new Date();
    hourly.time.forEach((time, i) => {
      const date = new Date(time);
      if (!Number.isFinite(date.getTime()) || date < new Date(now.getTime() - 60 * 60 * 1000) || shownHours >= 8) return;
      shownHours++;
      const hour = new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" }).format(date);
      const temperature = Number.isFinite(hourly.temperature_2m?.[i]) ? `${Math.round(hourly.temperature_2m[i])}°` : "—";
      const rain = Number.isFinite(hourly.precipitation_probability?.[i]) ? `${Math.round(hourly.precipitation_probability[i])}%` : "—";
      html += `<div class="hourly-row"><span>${escapeHtml(hour)}</span><span>${escapeHtml(weatherCondition(hourly.weather_code?.[i]))}</span><strong>${temperature}</strong><span class="hourly-rain">Опади ${rain}</span></div>`;
    });
  }
  if (!shownHours) html += `<p class="muted">Погодинний прогноз тимчасово недоступний.</p>`;
  html += `</div><h2>Історія погоди · 7 днів</h2><div class="history-list">`;
  const hist = data.history?.daily;
  if (Array.isArray(hist?.time) && hist.time.length) hist.time.forEach((day, i) => { html += `<div class="history-row"><div><div>${escapeHtml(formatDateUk(day))}</div><div class="date">${escapeHtml(weatherCondition(hist.weather_code?.[i]))}${Number.isFinite(hist.precipitation_sum?.[i]) ? ` · опади ${Math.round(hist.precipitation_sum[i]*10)/10} мм` : ""}</div></div><strong>${Number.isFinite(hist.temperature_2m_max?.[i]) ? Math.round(hist.temperature_2m_max[i]) : "—"}° / ${Number.isFinite(hist.temperature_2m_min?.[i]) ? Math.round(hist.temperature_2m_min[i]) : "—"}°</strong></div>`; });
  else html += `<p class="muted">Історичні дані зараз недоступні.</p>`;
  html += `</div>`;
  target.innerHTML = html;
}
async function loadSettlementsData() {
  if (settlementsData) return settlementsData;
  if (!settlementsPromise) {
    settlementsPromise = fetch(SETTLEMENTS_URL, { cache: "force-cache" })
      .then(response => { if (!response.ok) throw new Error("Settlement dataset unavailable"); return response.json(); })
      .then(data => {
        const rows = Array.isArray(data) ? data : (Array.isArray(data.settlements) ? data.settlements : []);
        settlementsData = rows.filter(row => row && typeof row.name === "string" && Array.isArray(row.location) && row.location.length >= 2 && Number.isFinite(Number(row.location[0])) && Number.isFinite(Number(row.location[1])));
        return settlementsData;
      })
      .catch(error => { settlementsPromise = null; throw error; });
  }
  return settlementsPromise;
}
function settlementIsPlace(row) {
  const type = normalize(row.type || "");
  // Keep actual populated places; exclude oblasts, districts, communities and other administrative records.
  return /^(село|селище|місто|селищеміськоготипу|селоміськоготипу|village|town|city|hamlet|locality)$/.test(type) || ["C", "M", "X"].includes(String(row.category || "").toUpperCase());
}
function districtCode(feature) {
  const p = propsOf(feature);
  for (const key of ["katotth_id", "KATOTTH", "katottg", "KATOTTG", "district_id", "raion_id", "id", "code"]) {
    const value = p[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}
async function settlementsForDistrict(feature) {
  const rows = await loadSettlementsData();
  const name = normalize(getName(feature, "district").replace(/район/ig, ""));
  const code = districtCode(feature);
  let matches = rows.filter(row => {
    if (!settlementIsPlace(row)) return false;
    const rowDistrict = normalize(row.district_name || "");
    const rowCode = String(row.district_id || "");
    if (code && rowCode && code === rowCode) return true;
    return rowDistrict && (rowDistrict === name || normalize(rowDistrict.replace(/район/ig, "")) === name);
  });
  // Some boundary files do not carry KATOTTH codes or use a slightly different district label.
  // In that case, locate settlements by their coordinates inside the selected district polygon.
  if (!matches.length && feature?.geometry) {
    matches = rows.filter(row => settlementIsPlace(row) && pointInGeometry([Number(row.location[1]), Number(row.location[0])], feature.geometry));
  }
  const unique = new Map();
  for (const row of matches) {
    const lon = Number(row.location[0]), lat = Number(row.location[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 44 || lat > 53 || lon < 21 || lon > 41) continue;
    const key = `${normalize(row.name)}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
    if (!unique.has(key)) unique.set(key, { name: row.name, lat, lon, type: row.type || "населений пункт" });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "uk"));
}
function renderSettlementList(places) {
  if (!places.length) return `<p class="muted">Не вдалося завантажити список населених пунктів цього району. Перевірте підключення до інтернету або дані джерела.</p>`;
  return `<label class="settlement-search-label" for="settlement-search">Пошук населеного пункту</label>
    <input id="settlement-search" class="settlement-search" type="search" placeholder="Наприклад, Знам’янка або Суботці" autocomplete="off">
    <p class="muted settlement-count">Населених пунктів: ${places.length}</p>
    <div id="settlement-list" class="settlement-list">${places.map((place, i) => `<button class="settlement-row" type="button" data-place-index="${i}"><span><strong>${escapeHtml(place.name)}</strong><span class="settlement-type">${escapeHtml(place.type)}</span></span><span class="settlement-meta">Погода →</span></button>`).join("")}</div>
    <div id="place-weather" class="place-weather" hidden></div>`;
}
function bindSettlementList(content, places) {
  content.querySelectorAll("[data-place-index]").forEach(button => button.addEventListener("click", () => {
    const place = places[Number(button.dataset.placeIndex)];
    const box = content.querySelector("#place-weather");
    if (place && box) showSettlementWeather(place, box);
  }));
  const search = content.querySelector("#settlement-search");
  if (search) search.addEventListener("input", () => {
    const q = normalize(search.value);
    content.querySelectorAll("[data-place-index]").forEach(button => {
      const place = places[Number(button.dataset.placeIndex)];
      button.hidden = !!q && !normalize(place?.name).includes(q);
    });
  });
}
async function showSettlementWeather(place, box) {
  box.hidden = false;
  box.innerHTML = `<strong>${escapeHtml(place.name)}</strong><p class="muted">Завантаження погоди…</p>`;
  try {
    const data = await fetchWeatherAt(place.lat, place.lon, false);
    if (!data.forecast?.current) throw new Error("no weather");
    const c = data.forecast.current;
    box.innerHTML = `<strong>${escapeHtml(place.name)}</strong><div class="temperature" style="font-size:28px;margin-top:6px">${Number.isFinite(c.temperature_2m) ? Math.round(c.temperature_2m)+"°C" : "невідомо"}</div><div>${escapeHtml(weatherCondition(c.weather_code))}</div><p class="small-note">Вітер: ${Number.isFinite(c.wind_speed_10m) ? Math.round(c.wind_speed_10m)+" км/год" : "невідомо"} · Вологість: ${Number.isFinite(c.relative_humidity_2m) ? Math.round(c.relative_humidity_2m)+"%" : "невідомо"}</p>`;
  } catch (_) { box.innerHTML = `<strong>${escapeHtml(place.name)}</strong><p class="muted">Погода: невідомо</p>`; }
}
async function openWeatherPanel(item) {
  const panel = document.getElementById("weather-panel"), content = document.getElementById("panel-content");
  const name = prettyDistrictName(item.feature);
  currentPanelItem = item;
  panel.hidden = false;
  const favoriteButton = document.getElementById("district-favorite");
  if (favoriteButton) favoriteButton.textContent = readFavorites().some(x => normalize(x.name) === normalize(name)) ? "★ Збережено" : "☆ Зберегти район";
  document.getElementById("panel-title").textContent = name;
  const seq = ++panelRequestSequence;
  content.innerHTML = `<p class="muted">Завантаження погоди та населених пунктів району…</p>`;
  const center = centerOf(item.feature);
  let places = [];
  let placesHtml = addSafetyLinks(name) + `<h2>Населені пункти району</h2>`;
  try {
    places = await settlementsForDistrict(item.feature);
    if (seq !== panelRequestSequence) return;
    placesHtml += renderSettlementList(places);
  } catch (error) {
    console.warn("Could not load settlement list:", error);
    placesHtml += `<p class="muted">Список населених пунктів тимчасово недоступний.</p>`;
  }
  if (!center) {
    content.innerHTML = `<p class="muted">Не вдалося визначити координати району.</p>${placesHtml}`;
    bindSettlementList(content, places);
    return;
  }
  content.innerHTML = `<p class="muted">Завантаження поточної погоди та історії…</p>${placesHtml}`;
  bindSettlementList(content, places);
  try {
    const data = await fetchWeatherAt(center[0], center[1], true);
    if (seq !== panelRequestSequence) return;
    content.innerHTML = `<h2>Поточна погода в районі</h2><div id="district-weather"></div>${placesHtml}`;
    renderWeatherData(data, document.getElementById("district-weather"));
    bindSettlementList(content, places);
  } catch (_) {
    if (seq !== panelRequestSequence) return;
    content.innerHTML = `<p class="muted">Не вдалося завантажити погоду району. Недоступні значення позначаються як «невідомо».</p>${placesHtml}`;
    bindSettlementList(content, places);
  }
}


async function loadNeighborRegions() {
  // All countries with available first-level administrative boundaries.
  // Ukraine is intentionally excluded: its existing districts/oblasts and weather remain untouched.
  const countryCodes = [
    "AFG","ALB","DZA","AND","AGO","ATG","ARG","ARM","AUS","AUT","AZE","BHS","BHR","BGD","BRB","BLR","BEL","BLZ","BEN","BTN","BOL","BIH","BWA","BRA","BRN","BGR","BFA","BDI","CPV","KHM","CMR","CAN","CAF","TCD","CHL","CHN","COL","COM","COG","CRI","CIV","HRV","CUB","CYP","CZE","PRK","COD","DNK","DJI","DMA","DOM","ECU","EGY","SLV","GNQ","ERI","EST","SWZ","ETH","FJI","FIN","FRA","GAB","GMB","GEO","DEU","GHA","GRC","GRD","GTM","GIN","GNB","GUY","HTI","HND","HUN","ISL","IND","IDN","IRN","IRQ","IRL","ISR","ITA","JAM","JPN","JOR","KAZ","KEN","KIR","KWT","KGZ","LAO","LVA","LBN","LSO","LBR","LBY","LIE","LTU","LUX","MDG","MWI","MYS","MDV","MLI","MLT","MHL","MRT","MUS","MEX","FSM","MCO","MNG","MNE","MAR","MOZ","MMR","NAM","NRU","NPL","NLD","NZL","NIC","NER","NGA","MKD","NOR","OMN","PAK","PLW","PAN","PNG","PRY","PER","PHL","POL","PRT","QAT","KOR","MDA","ROU","RUS","RWA","KNA","LCA","VCT","WSM","SMR","STP","SAU","SEN","SRB","SYC","SLE","SGP","SVK","SVN","SLB","SOM","ZAF","SSD","ESP","LKA","SDN","SUR","SWE","CHE","SYR","TJK","THA","TLS","TGO","TON","TTO","TUN","TUR","TKM","TUV","UGA","ARE","GBR","TZA","USA","URY","UZB","VUT","VAT","VEN","VNM","YEM","ZMB","ZWE","BOL","TWN","PSE","XKX"
  ];
  const countries = [...new Set(countryCodes)].filter(code => code !== "UKR").map(code => ({ code }));
  const pane = map.createPane("neighborRegionsPane");
  pane.style.zIndex = 425;
  pane.style.pointerEvents = "none";
  const labelPane = map.createPane("neighborRegionLabelsPane");
  labelPane.style.zIndex = 640;
  labelPane.style.pointerEvents = "none";
  const regionName = feature => {
    const p = feature && feature.properties ? feature.properties : {};
    for (const key of ["shapeName", "NAME_1", "name", "name_1", "region", "NAME", "shapeName_en", "admin1Name", "NAME_1_EN"]) {
      if (p[key] && String(p[key]).trim()) return String(p[key]).trim();
    }
    return "Регіон";
  };
  const loadCountry = async country => {
    try {
      const metaResponse = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${country.code}/ADM1/`);
      if (!metaResponse.ok) return;
      const metadata = await metaResponse.json();
      const geoUrl = metadata.gjDownloadURL || metadata.geojson || metadata.downloadURL;
      if (!geoUrl) return;
      const dataResponse = await fetch(geoUrl);
      if (!dataResponse.ok) return;
      const data = await dataResponse.json();
      const features = (data.features || []).filter(feature => feature && feature.geometry);
      if (!features.length) return;
      const layer = L.geoJSON({ type: "FeatureCollection", features }, {
        pane: "neighborRegionsPane",
        interactive: false,
        style: () => ({ color: "#d8e6f5", weight: 1.15, opacity: 0.9, fill: false, lineCap: "round", lineJoin: "round" })
      }).addTo(map);
      features.forEach(feature => {
        const regionLayer = L.geoJSON(feature);
        const bounds = regionLayer.getBounds();
        if (!bounds.isValid()) return;
        // Avoid clutter from very small regions; labels are names only, never weather values.
        const center = bounds.getCenter();
        const name = regionName(feature);
        const icon = L.divIcon({
          className: "neighbor-region-label-icon",
          html: `<div class="neighbor-region-label">${escapeHtml(name)}</div>`,
          iconSize: [150, 20],
          iconAnchor: [75, 10]
        });
        L.marker(center, { icon, pane: "neighborRegionLabelsPane", interactive: false, keyboard: false }).addTo(map);
      });
      // Keep the layer referenced by Leaflet; no click handlers or weather are attached.
      void layer;
    } catch (error) {
      console.warn(`Could not load administrative regions for ${country.code}:`, error);
    }
  };
  // Small batches reduce load on the free public boundary service.
  for (let i = 0; i < countries.length; i += 12) {
    await Promise.all(countries.slice(i, i + 12).map(loadCountry));
  }
}

function init() {
  renderFavorites();
  document.getElementById("district-favorite")?.addEventListener("click", () => {
    if (!currentPanelItem) return;
    const name = prettyDistrictName(currentPanelItem.feature); let items = readFavorites();
    if (items.some(x => normalize(x.name) === normalize(name))) items = items.filter(x => normalize(x.name) !== normalize(name));
    else items.push({ name });
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(items)); } catch (_) {}
    renderFavorites();
    const b = document.getElementById("district-favorite"); if (b) b.textContent = items.some(x => normalize(x.name) === normalize(name)) ? "★ Збережено" : "☆ Зберегти район";
  });
  document.getElementById("refresh-weather")?.addEventListener("click", async event => {
    if (!currentPanelItem) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "↻ Оновлюємо…";
    try { await openWeatherPanel(currentPanelItem); }
    finally { button.disabled = false; button.textContent = "↻ Оновити погоду"; }
  });
  document.getElementById("panel-close").addEventListener("click", () => { document.getElementById("weather-panel").hidden = true; panelRequestSequence++; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { document.getElementById("weather-panel").hidden = true; panelRequestSequence++; } });
  map = L.map("map", { zoomControl: false, attributionControl: false, scrollWheelZoom: true, doubleClickZoom: true, preferCanvas: true }).setView([48.8, 31.2], 6);
  // v28: public OpenStreetMap tiles; avoids Carto's API KEY REQUIRED watermark.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, updateWhenIdle: true, keepBuffer: 2,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  const status = document.getElementById("map-action-status");
  const showMapStatus = message => { if (!status) return; status.textContent = message; status.hidden = false; window.clearTimeout(showMapStatus.timer); showMapStatus.timer = window.setTimeout(() => { status.hidden = true; }, 5000); };
  // v15 extras: snowfall overlay, shareable map view, and fullscreen mode.
  const snowButton = document.getElementById("snow-toggle");
  const snowOverlay = document.getElementById("snow-overlay");
  snowButton?.addEventListener("click", () => {
    const enabled = snowOverlay.hidden;
    snowOverlay.hidden = !enabled;
    snowButton.setAttribute("aria-pressed", String(enabled));
    snowButton.innerHTML = enabled ? '❄ <span>Вимкнути сніг</span>' : '❄ <span>Снігопад</span>';
    showMapStatus(enabled ? "Зимовий снігопад увімкнено." : "Снігопад вимкнено.");
  });
  document.getElementById("share-map")?.addEventListener("click", async () => {
    const center = map.getCenter();
    const url = new URL(window.location.href);
    url.searchParams.set("lat", center.lat.toFixed(4));
    url.searchParams.set("lng", center.lng.toFixed(4));
    url.searchParams.set("zoom", String(map.getZoom()));
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url.toString());
        showMapStatus("Посилання на цей вигляд карти скопійовано.");
      } else {
        window.prompt("Скопіюйте посилання на карту:", url.toString());
      }
    } catch (_) { window.prompt("Скопіюйте посилання на карту:", url.toString()); }
  });
  const fullscreenButton = document.getElementById("fullscreen-toggle");
  fullscreenButton?.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) { showMapStatus("Повноекранний режим недоступний у цьому браузері."); }
  });
  document.addEventListener("fullscreenchange", () => {
    if (fullscreenButton) fullscreenButton.innerHTML = document.fullscreenElement ? '⛶ <span>Вийти з повного екрана</span>' : '⛶ <span>На весь екран</span>';
    setTimeout(() => map.invalidateSize(), 100);
  });
  // Restore a shared map view from URL parameters, when present.
  const sharedParams = new URLSearchParams(window.location.search);
  const sharedLat = Number(sharedParams.get("lat"));
  const sharedLng = Number(sharedParams.get("lng"));
  const sharedZoom = Number(sharedParams.get("zoom"));
  if (Number.isFinite(sharedLat) && Number.isFinite(sharedLng) && sharedParams.has("lat") && sharedParams.has("lng") && sharedLat >= -90 && sharedLat <= 90 && sharedLng >= -180 && sharedLng <= 180) {
    map.setView([sharedLat, sharedLng], Number.isFinite(sharedZoom) ? Math.max(3, Math.min(18, sharedZoom)) : 6);
  }

  document.getElementById("map-home")?.addEventListener("click", () => {
    if (fullMapBounds?.isValid()) map.fitBounds(fullMapBounds, { padding: [16, 16], animate: true });
    else map.setView([48.8, 31.2], 6);
    showMapStatus("Показано загальний огляд карти.");
  });
  document.getElementById("map-locate")?.addEventListener("click", () => {
    if (!navigator.geolocation) { showMapStatus("Ваш браузер не підтримує визначення місця."); return; }
    showMapStatus("Очікуємо дозвіл браузера на визначення місця…");
    navigator.geolocation.getCurrentPosition(position => {
      const latlng = [position.coords.latitude, position.coords.longitude];
      map.setView(latlng, Math.max(map.getZoom(), 8), { animate: true });
      if (userLocationMarker) userLocationMarker.setLatLng(latlng);
      else userLocationMarker = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2f80ed", fillOpacity: 1 }).addTo(map).bindTooltip("Ваше місце", { direction: "top" });
      showMapStatus("Місце показано. Координати не зберігаються сайтом.");
    }, error => {
      const message = error.code === 1 ? "Дозвольте доступ до місця у налаштуваннях браузера." : error.code === 2 ? "Не вдалося визначити місце. Перевірте GPS або мережу." : "Час очікування геолокації минув. Спробуйте ще раз.";
      showMapStatus(message);
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });
  map.createPane("oblastPane");
  map.getPane("oblastPane").style.zIndex = 430;
  map.getPane("overlayPane").style.zIndex = 410;
  Promise.all([fetch(OBLASTS_URL), fetch(RAIONS_URL)]).then(async ([or, rr]) => {
    if (!or.ok || !rr.ok) throw new Error("GeoJSON download failed");
    const [oblasts, raions] = await Promise.all([or.json(), rr.json()]);
    const allOblastFeatures = (oblasts.features || []).filter(f => f.geometry);
    const excludedOblasts = allOblastFeatures.filter(f => isExcludedOblastName(getName(f, "oblast")));
    oblastFeatures = allOblastFeatures.filter(f => !isExcludedOblastName(getName(f, "oblast")));
    const includedRaions = (raions.features || []).filter(feature => {
      if (!feature.geometry) return false;
      const parentName = districtParentName(feature);
      if (parentName && isExcludedOblastName(parentName)) return false;
      // Some source versions omit the parent oblast name, so also test the district's center.
      return !isInsideExcludedOblast(feature, excludedOblasts);
    });
    const filteredRaions = { ...raions, features: includedRaions };
    const districtLayer = L.geoJSON(filteredRaions, { style: baseStyle, onEachFeature: bindDistrict }).addTo(map);
    districtItems.forEach(item => { item.oblast = findOblastForDistrict(item.feature); item.layer.setStyle(baseStyle(item.oblast || item.feature)); });
    // Ukrainian flag-inspired luminous outline: blue above, yellow below.
    const outlineData = { ...oblasts, features: oblastFeatures };
    const flagGlowPane = map.createPane("flagGlowPane");
    flagGlowPane.style.zIndex = 420;
    flagGlowPane.style.pointerEvents = "none";
    L.geoJSON(outlineData, { pane: "flagGlowPane", interactive: false, style: () => ({ color: "#ffd83d", weight: 5, opacity: 0.72, fill: false, lineCap: "round", lineJoin: "round" }) }).addTo(map);
    L.geoJSON(outlineData, { pane: "flagGlowPane", interactive: false, style: () => ({ color: "#238cff", weight: 3, opacity: 0.98, fill: false, lineCap: "round", lineJoin: "round" }) }).addTo(map);
    L.geoJSON(outlineData, { pane: "oblastPane", interactive: false, style: () => ({ color: "#252b35", weight: 0.9, opacity: 1, fill: false }) }).addTo(map);
    addOblastLabels();
    // v23: show first-level administrative regions in neighboring countries too.
    // These are boundary/name overlays only; weather remains Ukraine-only.
    void loadNeighborRegions();
    void loadDistrictTemperatureColors();
    const bounds = districtLayer.getBounds();
    if (bounds.isValid()) { fullMapBounds = bounds; map.fitBounds(bounds, { padding: [12, 12] }); }
    document.getElementById("map-loading").hidden = true;
    setTimeout(() => map.invalidateSize(), 100);
  }).catch(error => {
    console.error("Map boundary loading failed:", error);
    const loading = document.getElementById("map-loading");
    loading.textContent = "Не вдалося завантажити межі. Перевірте інтернет-з’єднання.";
  });
}
window.addEventListener("load", () => {
  if (typeof L === "undefined") { document.getElementById("map-loading").textContent = "Не вдалося завантажити бібліотеку карти."; return; }
  init();
});


// Release notes are loaded from release-notes.json.
(function setupWhatsNew() {
  const STORAGE_KEY = "wezeraapp-whats-new-seen";
  async function initWhatsNew() {
    const modal = document.getElementById("whats-new");
    const ok = document.getElementById("whats-new-ok");
    if (!modal || !ok) return;
    let notes = { version: "2026-10-22-5", title: "Що нового?", items: [] };
    try {
      const response = await fetch("release-notes.json", { cache: "no-store" });
      if (response.ok) notes = await response.json();
    } catch (_) {}
    if (typeof notes.version !== "string" || !notes.version) notes.version = "unknown";
    const title = document.getElementById("whats-new-title");
    const list = document.getElementById("whats-new-list");
    if (title && notes.title) title.textContent = notes.title;
    if (list && Array.isArray(notes.items)) {
      list.replaceChildren();
      notes.items.forEach(item => {
        const li = document.createElement("li");
        li.textContent = String(item);
        list.appendChild(li);
      });
    }
    let seen = "";
    try { seen = localStorage.getItem(STORAGE_KEY) || ""; } catch (_) {}
    const updatesButton = document.getElementById("latest-updates-button");
    if (updatesButton) updatesButton.addEventListener("click", () => { modal.hidden = false; });
    const onboardingSeen = (() => { try { return localStorage.getItem("wezeraapp-onboarding-complete") === "1"; } catch (_) { return false; } })();
    if (seen !== notes.version && onboardingSeen) modal.hidden = false;
    ok.addEventListener("click", () => {
      modal.hidden = true;
      try { localStorage.setItem(STORAGE_KEY, notes.version); } catch (_) {}
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initWhatsNew);
  else initWhatsNew();
})();


// First-visit onboarding: short guided tour with Skip, Back and Next.
(function setupOnboarding() {
  const KEY = "wezeraapp-onboarding-complete";
  const steps = [
    { title: "Вітаємо на карті погоди!", text: "Натисніть на район України, щоб переглянути прогноз погоди." },
    { title: "Керуйте картою", text: "Кнопка «Уся карта» повертає загальний огляд, а «Моє місце» може показати вашу позицію після дозволу браузера." },
    { title: "Інструменти та вигляд", text: "У меню є шкала температур, снігопад, північне сяйво, вимірювання відстані та копіювання координат." },
    { title: "Ваші райони та оновлення", text: "Виберіть район для прогнозу. Натисніть «Останні оновлення» біля назви WezeraApp, щоб будь-коли переглянути зміни." }
  ];
  function init() {
    const modal = document.getElementById("onboarding");
    if (!modal) return;
    const title = document.getElementById("onboarding-title");
    const desc = document.getElementById("onboarding-description");
    const count = document.getElementById("onboarding-step-count");
    const fill = document.getElementById("onboarding-progress-fill");
    const back = document.getElementById("onboarding-back");
    const next = document.getElementById("onboarding-next");
    const skip = document.getElementById("onboarding-skip");
    let index = 0;
    let updatesModal = document.getElementById("whats-new");
    function finish() {
      modal.hidden = true;
      try { localStorage.setItem(KEY, "1"); } catch (_) {}
      const releaseModal = document.getElementById("whats-new");
      if (releaseModal) {
        let seen = "";
        try { seen = localStorage.getItem("wezeraapp-whats-new-seen") || ""; } catch (_) {}
        fetch("release-notes.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(notes => {
          if (notes && notes.version && seen !== notes.version) releaseModal.hidden = false;
        }).catch(() => {});
      }
    }
    function render() {
      const step = steps[index];
      title.textContent = step.title; desc.textContent = step.text;
      count.textContent = `Крок ${index + 1} із ${steps.length}`;
      fill.style.width = `${((index + 1) / steps.length) * 100}%`;
      back.hidden = index === 0;
      next.textContent = index === steps.length - 1 ? "Завершити" : "Далі";
    }
    try { if (localStorage.getItem(KEY) !== "1") { modal.hidden = false; render(); } } catch (_) { modal.hidden = false; render(); }
    next.addEventListener("click", () => { if (index < steps.length - 1) { index++; render(); } else finish(); });
    back.addEventListener("click", () => { if (index > 0) { index--; render(); } });
    skip.addEventListener("click", finish);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();

// v14: toggleable temperature legend; purely informational and does not alter map data.
document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("legend-toggle");
  const legend = document.getElementById("temperature-legend");
  if (!button || !legend) return;
  button.addEventListener("click", () => {
    const open = legend.hidden;
    legend.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.innerHTML = open ? '🌡 <span>Сховати шкалу</span>' : '🌡 <span>Шкала температур</span>';
  });
});


// v16: interactive distance measurement; does not alter district layers or weather data.
document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("measure-toggle");
  const status = document.getElementById("map-action-status");
  if (!button || !status) return;
  let active = false;
  let points = [];
  let line = null;
  let markers = [];
  const clearMeasure = () => {
    if (line && map) map.removeLayer(line);
    markers.forEach(marker => { if (map) map.removeLayer(marker); });
    line = null; markers = []; points = [];
  };
  button.addEventListener("click", () => {
    if (!active) {
      active = true; button.setAttribute("aria-pressed", "true");
      button.innerHTML = '📏 <span>Завершити вимірювання</span>';
      status.textContent = "Натисніть на карту, щоб позначити початок і кінець маршруту."; status.hidden = false;
    } else {
      active = false; clearMeasure(); button.setAttribute("aria-pressed", "false");
      button.innerHTML = '📏 <span>Виміряти відстань</span>';
      status.textContent = "Вимірювання очищено.";
      window.setTimeout(() => { status.hidden = true; }, 2200);
    }
  });
  const waitForMap = () => {
    if (typeof map === "undefined" || !map || typeof L === "undefined") { window.setTimeout(waitForMap, 300); return; }
    map.on("click", event => {
      if (!active) return;
      if (points.length >= 2) clearMeasure();
      points.push(event.latlng);
      markers.push(L.circleMarker(event.latlng, { radius: 6, color: "#ffffff", weight: 2, fillColor: "#168cff", fillOpacity: 1, interactive: false }).addTo(map));
      if (points.length === 2) {
        line = L.polyline(points, { color: "#ffd83d", weight: 4, dashArray: "8 6", interactive: false }).addTo(map);
        const distance = map.distance(points[0], points[1]);
        const value = distance >= 1000 ? (distance / 1000).toFixed(2) + " км" : Math.round(distance) + " м";
        status.textContent = "Відстань по прямій: " + value + ". Натисніть ще раз на карту для нового вимірювання.";
      } else status.textContent = "Початок позначено. Натисніть на карту в іншому місці.";
      status.hidden = false;
    });
  };
  waitForMap();
});


// v17: tap-to-copy geographic coordinates without modifying map layers.
document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("coordinates-toggle");
  const status = document.getElementById("map-action-status");
  if (!button || !status) return;
  let active = false;
  button.addEventListener("click", () => {
    active = !active;
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = active ? '⌖ <span>Скасувати вибір точки</span>' : '⌖ <span>Координати точки</span>' ;
    status.textContent = active ? "Натисніть на карту, щоб скопіювати координати точки." : "Вибір координат скасовано.";
    status.hidden = false;
    if (!active) window.setTimeout(() => { status.hidden = true; }, 1800);
  });
  const waitForMap = () => {
    if (typeof map === "undefined" || !map || typeof L === "undefined") { window.setTimeout(waitForMap, 300); return; }
    map.on("click", async event => {
      if (!active) return;
      const lat = event.latlng.lat.toFixed(5);
      const lon = event.latlng.lng.toFixed(5);
      const coords = `${lat}, ${lon}`;
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(coords);
        else {
          const field = document.createElement("textarea"); field.value = coords; field.style.position = "fixed"; field.style.opacity = "0"; document.body.appendChild(field); field.select();
          const copied = document.execCommand("copy"); field.remove(); if (!copied) throw new Error("copy unavailable");
        }
        status.textContent = `Координати скопійовано: ${coords}`;
      } catch (_) { status.textContent = `Координати точки: ${coords} (скопіюйте вручну)`; }
      status.hidden = false;
      active = false; button.setAttribute("aria-pressed", "false"); button.innerHTML = '⌖ <span>Координати точки</span>' ;
    });
  };
  waitForMap();
});


// v18: toggle oblast labels for a cleaner map view; underlying map data is unchanged.
(() => {
  const button = document.getElementById("labels-toggle");
  if (!button) return;
  let visible = true;
  button.addEventListener("click", () => {
    visible = !visible;
    for (const marker of oblastLabelMarkers) {
      if (visible && map && !map.hasLayer(marker)) marker.addTo(map);
      else if (!visible && map && map.hasLayer(marker)) map.removeLayer(marker);
    }
    button.setAttribute("aria-pressed", String(visible));
    button.innerHTML = visible ? 'Aa <span>Приховати назви</span>' : 'Aa <span>Показати назви</span>';
    showMapStatus(visible ? "Назви областей показано." : "Назви областей приховано для чистішого огляду.");
  });
})();
