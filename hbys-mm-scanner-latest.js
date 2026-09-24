(async () => {
  'use strict';

  const VERSION = '3.2.0';
  const WINDOW_DAYS = 30;
  const PATIENT_CONCURRENCY = 4;
  const REQUEST_TIMEOUT_MS = 15000;
  const Ext = window.Ext;

  if (window.__hbysMmScanner?.running) {
    window.__hbysMmScanner.panel?.scrollIntoView({ block: 'center' });
    return;
  }
  try { window.__hbysMmScanner?.restore?.(); } catch (_) {}
  document.querySelector('#hbys-mm-scanner-panel')?.remove();

  const state = {
    version: VERSION, running: true, stopped: false, cases: [], results: [], errors: [], manual: [],
    metrics: { total: 0, completed: 0, requests: 0, failedRequests: 0 }, aborters: new Set()
  };
  window.__hbysMmScanner = state;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const multiline = (value) => String(value ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\r/g, '').split('\n').map(clean).filter(Boolean).join('\n');
  const humanText = (value) => {
    const text = clean(value);
    return /^(?:[-+]?\d+(?:[.,]\d+)?)$/.test(text) ? '' : text;
  };
  const norm = (value) => clean(value).toLocaleLowerCase('tr-TR');
  const html = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (value, max = 32700) => String(value ?? '').slice(0, max);
  const readPath = (obj, path) => clean(path).split('.').reduce((acc, key) => acc == null ? undefined : acc[key], obj);
  const recordValue = (record, names) => {
    for (const name of names) {
      try { const value = record?.get?.(name); if (value != null && value !== '') return value; } catch (_) {}
      try { const value = record?.data?.[name]; if (value != null && value !== '') return value; } catch (_) {}
      try { const value = readPath(record?.data, name); if (value != null && value !== '') return value; } catch (_) {}
    }
    return '';
  };
  const deepEntries = (obj, out = [], path = '', depth = 0, seen = new WeakSet()) => {
    if (!obj || typeof obj !== 'object' || depth > 8 || seen.has(obj)) return out;
    seen.add(obj);
    for (const [key, value] of Object.entries(obj)) {
      const next = path ? `${path}.${key}` : key;
      if (value != null && typeof value !== 'object') out.push([next, value]);
      else deepEntries(value, out, next, depth + 1, seen);
    }
    return out;
  };
  const deepValue = (obj, keyPattern, valueTest = () => true) => {
    const item = deepEntries(obj).find(([path, value]) => keyPattern.test(path) && valueTest(value));
    return item?.[1] ?? '';
  };
  const deepObjectId = (obj, predicate, depth = 0, seen = new WeakSet()) => {
    if (!obj || typeof obj !== 'object' || depth > 7 || seen.has(obj)) return '';
    seen.add(obj);
    try { if (predicate(obj) && obj.id != null) return obj.id; } catch (_) {}
    for (const value of Object.values(obj)) {
      const found = deepObjectId(value, predicate, depth + 1, seen);
      if (found !== '') return found;
    }
    return '';
  };

  const parseDate = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
    const text = clean(value);
    let m = text.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = text.match(/(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return null;
  };
  const dateMs = (value) => parseDate(value)?.getTime() ?? NaN;
  const startOfDay = (value) => { const d = parseDate(value); return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() : NaN; };
  const pod = (operationDate, eventDate) => {
    const a = startOfDay(operationDate); const b = startOfDay(eventDate);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
  };
  const inPostopWindow = (operationDate, eventDate) => {
    const operationMs = dateMs(operationDate); const eventMs = dateMs(eventDate); const value = pod(operationDate, eventDate);
    return Number.isFinite(operationMs) && Number.isFinite(eventMs) && eventMs >= operationMs && value != null && value <= WINDOW_DAYS;
  };
  const formatDate = (value) => {
    const d = parseDate(value); if (!d) return clean(value);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const standardOperationName = (value) => clean(value).replace(/^\d+\s*[-–:]\s*/, '').replace(/\s+/g, ' ');
  const operationGroupKey = (value) => norm(standardOperationName(value)).replace(/[.,;]+$/g, '');
  const firstValue = (...values) => values.find((value) => value != null && clean(value) !== '') ?? '';
  const arrayData = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.data)) return payload.data.data;
    if (Array.isArray(payload?.list)) return payload.list;
    return [];
  };

  const panel = document.createElement('div');
  panel.id = 'hbys-mm-scanner-panel';
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:650px;max-height:82vh;overflow:auto;background:#10212b;color:#eef7fb;border:1px solid #4e7487;border-radius:10px;box-shadow:0 8px 30px #0008;font:12px/1.35 Arial;padding:12px';
  panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:15px">HBYS MM Arka Plan Tarayıcı</b><span style="display:flex;align-items:center;gap:8px"><span>v${VERSION}</span><button id="hbys-mm-close" title="Kapat" aria-label="Kapat" style="width:28px;height:28px;border:0;border-radius:50%;background:#b43b3b;color:#fff;font:bold 20px/24px Arial;cursor:pointer">×</button></span></div><div id="hbys-mm-status" style="margin-top:6px">Ameliyat listesi okunuyor…</div><div style="height:7px;background:#27414f;border-radius:6px;margin:8px 0"><div id="hbys-mm-progress" style="height:100%;width:0;background:#43c59e;border-radius:6px"></div></div><div id="hbys-mm-summary" style="max-height:360px;overflow:auto;border:1px solid #31505f"></div><pre id="hbys-mm-log" style="white-space:pre-wrap;max-height:120px;overflow:auto;margin:7px 0;color:#cde3ed"></pre><div style="display:flex;gap:6px;flex-wrap:wrap"><button id="hbys-mm-stop">Durdur</button><button id="hbys-mm-xlsx" disabled>Excel (.xlsx) indir</button><button id="hbys-mm-json" disabled>Ayrıntılı JSON indir</button></div><small style="display:block;margin-top:7px;color:#9fc3d3">Salt okunur: yalnızca GET sorguları. Konsültasyon ve görüntülemeler ameliyat saatinden sonra, POD 0–30 aralığından alınır. Veri eksikliği morbidite veya manuel klinik doğrulama sayılmaz.</small>`;
  document.body.appendChild(panel);
  state.panel = panel;
  const statusEl = panel.querySelector('#hbys-mm-status');
  const progressEl = panel.querySelector('#hbys-mm-progress');
  const summaryEl = panel.querySelector('#hbys-mm-summary');
  const logEl = panel.querySelector('#hbys-mm-log');
  const stopEl = panel.querySelector('#hbys-mm-stop');
  const closeEl = panel.querySelector('#hbys-mm-close');
  const xlsxEl = panel.querySelector('#hbys-mm-xlsx');
  const jsonEl = panel.querySelector('#hbys-mm-json');
  const log = (line) => { if (logEl?.isConnected) logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 12000); };
  const stop = () => {
    state.stopped = true; state.aborters.forEach((controller) => controller.abort());
    if (statusEl?.isConnected) statusEl.textContent = 'Güvenli biçimde durduruluyor…';
  };
  stopEl.onclick = stop;
  closeEl.onclick = () => { stop(); panel.remove(); };
  state.restore = () => { stop(); panel.remove(); };

  const baseUrl = () => `${location.origin}/hbys-rs/hbys`;
  const apiGet = async (path, params = {}, attempt = 0) => {
    if (state.stopped) throw new Error('Kullanıcı durdurdu');
    if (!/^\//.test(path)) throw new Error('Güvenlik: yalnızca FONET iç servis yolu kullanılabilir');
    const query = new URLSearchParams({ _dc: Date.now() });
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
      else if (value != null && value !== '') query.set(key, value);
    });
    const controller = new AbortController(); state.aborters.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); state.metrics.requests += 1;
    try {
      const response = await fetch(`${baseUrl()}${path}${path.includes('?') ? '&' : '?'}${query}`, {
        method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
      try { return text ? JSON.parse(text) : {}; } catch (_) { throw new Error(`JSON okunamadı: ${text.slice(0, 160)}`); }
    } catch (error) {
      state.metrics.failedRequests += 1;
      if (!state.stopped && attempt < 1 && /abort|network|fetch|HTTP 5\d\d/i.test(String(error.message || error))) {
        await sleep(250 + Math.round(Math.random() * 250)); return apiGet(path, params, attempt + 1);
      }
      throw error;
    } finally { clearTimeout(timer); state.aborters.delete(controller); }
  };

  const gridHeaders = (grid) => (grid.columns || grid.headerCt?.getGridColumns?.() || []).map((column) => clean(column.text || column.dataIndex));
  const findSurgeryGrid = () => {
    if (!Ext?.ComponentQuery) return null;
    return Ext.ComponentQuery.query('gridpanel, grid').filter((grid) => {
      const headers = gridHeaders(grid).map(norm); const count = grid.getStore?.().getCount?.() || 0;
      return count > 0 && headers.some((x) => x === 'işlem no' || x === 'islem no') && headers.some((x) => x.includes('adı soyadı') || x.includes('adi soyadi')) && headers.some((x) => x.includes('ameliyat 1'));
    }).sort((a, b) => (b.getStore?.().getCount?.() || 0) - (a.getStore?.().getCount?.() || 0))[0] || null;
  };
  const cellTexts = (row) => [...row.querySelectorAll('.x-grid-cell-inner')].map((cell) => clean(cell.innerText));
  const inferIds = (data = {}) => ({
    birimSevkId: firstValue(data.birimSevk?.id, data.hastaBirimSevk?.id, data.klinik?.birimSevk?.id, deepValue(data, /(^|\.)birimSevkId$/i, (v) => /^\d+$/.test(clean(v))), deepObjectId(data, (x) => x.birim && x.hastaGelis)),
    hastaGelisId: firstValue(data.hastaGelis?.id, data.birimSevk?.hastaGelis?.id, data.hastaBirimSevk?.hastaGelis?.id, deepValue(data, /(^|\.)hastaGelisId$/i, (v) => /^\d+$/.test(clean(v))), deepObjectId(data, (x) => x.hasta && (x.muracaatTarihi || x.protokolNo))),
    hastaId: firstValue(data.hasta?.id, data.hastaGelis?.hasta?.id, data.birimSevk?.hastaGelis?.hasta?.id, deepValue(data, /(^|\.)hastaId$/i, (v) => /^\d+$/.test(clean(v))), deepObjectId(data, (x) => x.kimlik && x.id)),
    kimlikId: firstValue(data.hasta?.kimlik?.id, data.hastaGelis?.hasta?.kimlik?.id, data.birimSevk?.hastaGelis?.hasta?.kimlik?.id, deepValue(data, /kimlik\.id$|kimlikId$/i, (v) => /^\d+$/.test(clean(v))))
  });
  const collectCases = async () => {
    const grid = findSurgeryGrid();
    if (!grid) throw new Error('Ameliyat listesi bulunamadı. Tarih aralığını sorgulayıp ameliyat listesini ekranda bırakın.');
    const store = grid.getStore(); const viewRows = [...(grid.getView?.().el?.dom?.querySelectorAll?.('.x-grid-row') || [])];
    let sourceRecords = store.getRange?.() || [];
    const total = Number(store.getTotalCount?.() || sourceRecords.length);
    if (total > sourceRecords.length) {
      try {
        const proxy = store.getProxy?.(); const rawUrl = clean(proxy?.url || proxy?.api?.read);
        if (!rawUrl) throw new Error('liste servis yolu bulunamadı');
        const parsed = new URL(rawUrl, location.origin);
        if (parsed.origin !== location.origin) throw new Error('liste servisi FONET dışı');
        const path = parsed.pathname.replace(/^\/hbys-rs\/hbys/, '');
        const params = Object.fromEntries(parsed.searchParams.entries());
        Object.assign(params, proxy?.extraParams || {}, { start: 0, page: 1, limit: total });
        const payload = await apiGet(path, params); const loaded = arrayData(payload);
        if (loaded.length) sourceRecords = loaded.map((data) => ({ data, get: (key) => data[key], getId: () => data.id }));
      } catch (error) {
        state.manual.push({ hasta: 'Liste geneli', işlemNo: '', ameliyat: '', konu: 'Sayfalama', açıklama: `FONET listesinde ${total} kayıt var; toplu yükleme başarısız: ${clean(error.message)}`, kaynak: 'Ameliyat listesi' });
      }
    }
    const records = [];
    sourceRecords.forEach((record, index) => {
      const data = record.data || {};
      const cells = cellTexts(viewRows.find((row) => Number(row.dataset.recordindex) === index) || viewRows[index] || document.createElement('tr'));
      const ids = inferIds(data);
      const operationDate = firstValue(cells[2], recordValue(record, ['ameliyatTarihi', 'tarih', 'baslangicTarihi', 'başlangıçTarihi', 'istekTarihi']), deepValue(data, /ameliyat.*tarih|baslangicTarihi|başlangıçTarihi/i));
      const operation = firstValue(cells[11], recordValue(record, ['ameliyat1', 'ameliyat', 'ameliyatAdi', 'hizmetKoduAdi']), deepValue(data, /ameliyat1|ameliyatAdi|ameliyat\.adi/i));
      const name = firstValue(cells[6], recordValue(record, ['adiSoyadi', 'adSoyad', 'hastaAdiSoyadi', 'hasta.adiSoyadi']), deepValue(data, /kimlik\.adiSoyadi|hasta.*adiSoyadi/i));
      const transaction = firstValue(cells[5], recordValue(record, ['islemNo', 'işlemNo', 'protokolNo', 'hastaGelis.protokolNo']), deepValue(data, /islemNo|işlemNo|protokolNo/i));
      if (!name || !operation || !parseDate(operationDate)) return;
      records.push({
        sourceIndex: index, surgeryRecordId: clean(firstValue(record.getId?.(), data.id)), işlemNo: clean(transaction),
        protokolNo: clean(firstValue(recordValue(record, ['protokolNo', 'protokol', 'hastaGelis.protokolNo']), transaction)),
        adSoyad: clean(name), tcKimlikNo: clean(firstValue(recordValue(record, ['kimlikNo', 'tcKimlikNo', 'hasta.kimlik.kimlikNo', 'hastaGelis.hasta.kimlik.kimlikNo']), deepValue(data, /kimlik.*(kimlikNo|tcKimlikNo)$/i))),
        ameliyatTarihi: formatDate(operationDate), ameliyat: clean(operation), standartAmeliyatAdı: standardOperationName(operation),
        doktor: clean(firstValue(cells[7], recordValue(record, ['doktorAdi', 'personel.kimlik.adiSoyadi']))),
        uzmanlık: clean(firstValue(cells[8], recordValue(record, ['uzmanlikAdi', 'birim.uzmanlik.adi']))),
        birimSevkId: clean(ids.birimSevkId),
        hastaGelisId: clean(firstValue(ids.hastaGelisId, recordValue(record, ['hastaGelisId', 'gelisId']), data.id, record.getId?.())),
        hastaId: clean(ids.hastaId), kimlikId: clean(ids.kimlikId), rawRecordKeys: Object.keys(data)
      });
    });
    const key = (x) => x.surgeryRecordId || [x.işlemNo, x.adSoyad, x.ameliyatTarihi, operationGroupKey(x.ameliyat)].join('|');
    const counts = new Map(); records.forEach((item) => counts.set(key(item), (counts.get(key(item)) || 0) + 1));
    const unique = records.filter((item, index, all) => all.findIndex((other) => key(other) === key(item)) === index);
    unique.forEach((item) => { item.mükerrerListeSatırı = Math.max(0, (counts.get(key(item)) || 1) - 1); });
    const encounters = new Map();
    unique.sort((a, b) => dateMs(a.ameliyatTarihi) - dateMs(b.ameliyatTarihi)).forEach((item) => {
      const encounterKey = `${item.hastaId || item.tcKimlikNo || norm(item.adSoyad)}|${item.işlemNo || item.protokolNo}`;
      if (!encounters.has(encounterKey)) encounters.set(encounterKey, { ...item, listeSonrakiAmeliyatlar: [] });
      else encounters.get(encounterKey).listeSonrakiAmeliyatlar.push(item);
    });
    const indexCases = [...encounters.values()];
    if (total > sourceRecords.length) state.manual.push({ hasta: 'Liste geneli', işlemNo: '', ameliyat: '', konu: 'Sayfalama', açıklama: `FONET listesinde ${total} kayıt var; yalnızca ${sourceRecords.length} kayıt okunabildi.`, kaynak: 'Ameliyat listesi' });
    return { raw: records, unique: indexCases };
  };

  const clinicalRoot = (payload) => payload?.data || payload || {};
  const applyClinical = (result, payload, source) => {
    const root = clinicalRoot(payload); const entries = deepEntries(root);
    const pick = (regex) => entries.find(([path, value]) => regex.test(path) && clean(value))?.[1] ?? '';
    result.birimSevkId ||= clean(firstValue(root.birimSevk?.id, root.hastaBirimSevk?.id, root.klinik?.birimSevk?.id, pick(/(^|\.)birimSevkId$/i)));
    result.hastaGelisId ||= clean(firstValue(root.birimSevk?.hastaGelis?.id, root.hastaGelis?.id, root.hastaBirimSevk?.hastaGelis?.id, pick(/(^|\.)hastaGelisId$/i)));
    result.hastaId ||= clean(firstValue(root.birimSevk?.hastaGelis?.hasta?.id, root.hastaGelis?.hasta?.id, root.hasta?.id, pick(/(^|\.)hastaId$/i)));
    result.kimlikId ||= clean(firstValue(root.birimSevk?.hastaGelis?.hasta?.kimlik?.id, root.hastaGelis?.hasta?.kimlik?.id, root.hasta?.kimlik?.id, pick(/kimlik\.id$|kimlikId$/i)));
    result.tcKimlikNo ||= clean(firstValue(root.birimSevk?.hastaGelis?.hasta?.kimlik?.kimlikNo, root.hastaGelis?.hasta?.kimlik?.kimlikNo, root.hasta?.kimlik?.kimlikNo, pick(/kimlik.*(kimlikNo|tcKimlikNo)$/i)));
    result.protokolNo ||= clean(firstValue(root.birimSevk?.hastaGelis?.protokolNo, root.hastaGelis?.protokolNo, pick(/protokolNo$/i), result.işlemNo));
    result.yatışTarihi ||= formatDate(firstValue(root.klinik?.yatisTarihi, root.klinik?.yatışTarihi, root.birimSevk?.yatisTarihi, root.hastaBirimSevk?.yatisTarihi, root.birimSevk?.sevkTarihi, root.hastaBirimSevk?.sevkTarihi, root.hastaGelis?.muracaatTarihi, pick(/yatisTarihi$|yatışTarihi$/i)));
    result.taburculukTarihi ||= formatDate(firstValue(root.klinik?.cikisTarihi, root.klinik?.çıkışTarihi, root.klinik?.bitisTarihi, root.birimSevk?.cikisTarihi, root.birimSevk?.bitisTarihi, root.hastaBirimSevk?.cikisTarihi, root.hastaBirimSevk?.bitisTarihi, root.hastaGelis?.cikisTarihi, pick(/cikisTarihi$|çıkışTarihi$|taburcu.*tarih|bitisTarihi$/i)));
    const unitText = entries.filter(([path]) => /birim.*adi$|servis.*adi$|klinik.*adi$/i.test(path)).map(([, value]) => clean(value)).join(' | ');
    if (/yoğun bakım|yogun bakim/i.test(unitText)) result.yoğunBakım.push({ tarih: result.yatışTarihi, birim: unitText, kaynak: source });
    const deathDate = firstValue(pick(/olumTarihi$|ölümTarihi$|vefatTarihi$/i));
    const deathFlag = entries.find(([path, value]) => /olduMu$|vefat.*(mi|durum)|olum.*(mu|durum)/i.test(path) && (value === true || /^(1|evet|true)$/i.test(clean(value))));
    if (deathDate || deathFlag) result.ölüm = { var: true, tarih: formatDate(deathDate), kaynak: source };
  };

  const consultAnswer = (row) => multiline([row.sonucAciklama, row.sonucAciklama2, row.konsultasyonSonucu, row.cevap].filter(Boolean).join('\n'));
  const historyInterval = (row) => ({
    id: clean(row.id),
    hastaGelisId: clean(firstValue(row.hastaGelis?.id, row.hastaGelisId, row.birimSevk?.hastaGelis?.id)),
    birimSevkId: clean(firstValue(row.birimSevk?.id, row.birimSevkId, row.id)),
    start: firstValue(row.yatisTarihi, row.yatışTarihi, row.sevkTarihi, row.kabulTarihi, row.hastaGelis?.muracaatTarihi),
    end: firstValue(row.cikisTarihi, row.çıkışTarihi, row.bitisTarihi, row.taburcuTarihi, row.klinik?.cikisTarihi, row.klinik?.bitisTarihi),
    unit: clean(firstValue(row.birim?.adi, row.birimAdi, row.klinik?.yatak?.oda?.birim?.adi))
  });
  const applyHistoryEpisode = (result, rows) => {
    const operationMs = dateMs(result.ameliyatTarihi); const transferGapMs = 12 * 60 * 60 * 1000;
    const intervals = rows.map(historyInterval).filter((row) => Number.isFinite(dateMs(row.start)) && Number.isFinite(dateMs(row.end)) && dateMs(row.end) >= dateMs(row.start)).sort((a, b) => dateMs(a.start) - dateMs(b.start));
    const seedIndex = intervals.findIndex((row) => dateMs(row.start) <= operationMs && operationMs <= dateMs(row.end));
    if (seedIndex < 0) return;
    let left = seedIndex; let right = seedIndex; let episodeStart = dateMs(intervals[seedIndex].start); let episodeEnd = dateMs(intervals[seedIndex].end);
    while (left > 0 && episodeStart - dateMs(intervals[left - 1].end) <= transferGapMs && dateMs(intervals[left - 1].end) >= episodeStart - transferGapMs) {
      left -= 1; episodeStart = Math.min(episodeStart, dateMs(intervals[left].start));
    }
    while (right + 1 < intervals.length && dateMs(intervals[right + 1].start) <= episodeEnd + transferGapMs) {
      right += 1; episodeEnd = Math.max(episodeEnd, dateMs(intervals[right].end));
    }
    const episode = intervals.slice(left, right + 1);
    result.yatışTarihi = formatDate(episodeStart);
    result.taburculukTarihi = formatDate(episodeEnd);
    result.yatışKaynağı = `Hasta Geçmişi ${episode.map((row) => row.id).filter(Boolean).join(', ')}`;
    result.historyEncounterIds = [...new Set(episode.map((row) => row.hastaGelisId).filter(Boolean))];
  };
  const fetchPatientHistory = async (result) => {
    if (!result.kimlikId) throw new Error('kimlikId bulunamadı');
    const payload = await apiGet('/Hasta/HastaGecmis/getSevkList', {
      filter: JSON.stringify([{ property: 'hastaGelis.hasta.kimlik.id', type: 'Long', value: Number(result.kimlikId), operator: '=' }]),
      page: 1, start: 0, limit: 250, sort: JSON.stringify([{ property: 'sevkTarihi', direction: 'DESC' }])
    });
    return arrayData(payload);
  };
  const historyEpisodes = (rows) => {
    const transferGapMs = 12 * 60 * 60 * 1000;
    const intervals = rows.map(historyInterval)
      .filter((row) => Number.isFinite(dateMs(row.start)) && Number.isFinite(dateMs(row.end)) && dateMs(row.end) >= dateMs(row.start))
      .sort((a, b) => dateMs(a.start) - dateMs(b.start));
    const episodes = [];
    intervals.forEach((interval) => {
      const startMs = dateMs(interval.start); const endMs = dateMs(interval.end); const last = episodes.at(-1);
      if (last && startMs <= last.endMs + transferGapMs) {
        last.endMs = Math.max(last.endMs, endMs); last.intervals.push(interval);
      } else episodes.push({ startMs, endMs, intervals: [interval] });
    });
    return episodes;
  };
  const applyHistoryReadmission = (result, rows) => {
    const operationMs = dateMs(result.ameliyatTarihi); const episodes = historyEpisodes(rows);
    const indexEpisode = episodes.find((episode) => episode.startMs <= operationMs && operationMs <= episode.endMs);
    if (!indexEpisode) return;
    result.yenidenBaşvuruYatış = episodes.filter((episode) => episode.startMs > indexEpisode.endMs && pod(result.ameliyatTarihi, episode.startMs) <= WINDOW_DAYS)
      .map((episode) => ({
        tarih: formatDate(episode.startMs), taburculukTarihi: formatDate(episode.endMs),
        hastaGelisId: clean(episode.intervals.map((row) => row.hastaGelisId).find(Boolean)),
        fonetKaydı: `Hasta Geçmişi ${episode.intervals.map((row) => row.id).filter(Boolean).join(', ')}`,
        doğrulama: 'Hasta Geçmişi kaydında yeni yatış epizodu'
      }));
  };
  const discoverEncounterHints = async (result) => {
    if (!result.hastaId) return [];
    const payload = await apiGet('/Lis/LisRaporSonuc/getLisRaporHastaInfoList', {
      filter: JSON.stringify([{ property: 'hastaId', value: Number(result.hastaId), type: 'Long', operator: '=' }]),
      page: 1, start: 0, limit: 250, sort: JSON.stringify([{ property: 'lisKabulTarihi', direction: 'DESC' }])
    });
    return arrayData(payload).map((row) => {
      const date = firstValue(row.lisKabulTarihi, row.kabulTarihi, row.etar, row.tarih);
      return {
        hastaGelisId: clean(firstValue(row.hastaGelisId, row.hastaGelis?.id, row.birimSevk?.hastaGelis?.id)),
        birimSevkId: clean(firstValue(row.birimSevkId, row.birimSevk?.id)), tarih: formatDate(date),
        birim: clean(firstValue(row.birimAdi, row.birim?.adi, row.birimSevk?.birim?.adi)),
        fonetKaydı: `LIS kabul ${clean(firstValue(row.lisKabulId, row.id)) || '(kimlik yok)'}`
      };
    }).filter((row) => row.hastaGelisId && inPostopWindow(result.ameliyatTarihi, row.tarih))
      .filter((row, index, all) => all.findIndex((other) => other.hastaGelisId === row.hastaGelisId) === index);
  };
  const fetchConsultations = async (result) => {
    const encounterIds = [...new Set([result.hastaGelisId, ...(result.historyEncounterIds || []), ...(result.yenidenBaşvuruYatış || []).map((x) => x.hastaGelisId)].filter(Boolean))];
    if (!encounterIds.length) throw new Error('hastaGelisId bulunamadı');
    const rows = [];
    await runPool(encounterIds, 3, async (encounterId) => {
      const payload = await apiGet(`/Poliklinik/Poliklinik/getHastaGelisKonsultasyonList/${encodeURIComponent(encounterId)}/1`);
      rows.push(...arrayData(payload).map((row) => ({ ...row, __hastaGelisId: encounterId })));
    });
    return rows.map((row) => {
      const date = firstValue(row.birimSevk?.sevkTarihi, row.etar, row.istemTarihi, row.tarih);
      return { id: clean(row.id), hastaGelisId: clean(row.__hastaGelisId), tarih: formatDate(date), pod: pod(result.ameliyatTarihi, date), birim: humanText(firstValue(row.birimSevk?.birim?.adi, row.istenenBirim?.adi, row.birimAdi)), hekim: humanText(firstValue(row.birimSevk?.personel?.kimlik?.adiSoyadi, row.personel?.kimlik?.adiSoyadi, row.doktorAdi)), istem: multiline(firstValue(row.istemSebebi, row.istemAciklama, row.aciklama)), sonuç: consultAnswer(row), durum: humanText(row.durum), fonetKaydı: `Konsültasyon ${clean(row.id) || '(kimlik yok)'}`, fonetTarihi: formatDate(date) };
    }).filter((row) => inPostopWindow(result.ameliyatTarihi, row.tarih))
      .filter((row, index, all) => all.findIndex((other) => clean(other.id) === clean(row.id) && clean(other.hastaGelisId) === clean(row.hastaGelisId)) === index);
  };

  const radiologyTextFromRaw = (value) => multiline(value);
  const deepRadiologyText = (payload) => {
    const root = payload?.data || payload || {};
    const direct = firstValue(root.raporTextByRapor, root.raporText, root.raporMetni, root.raporHtml, root.rapor, root.bulgu, root.bulgular, root.sonuc, root.sonucAciklama);
    if (radiologyTextFromRaw(direct)) return radiologyTextFromRaw(direct);
    const candidates = deepEntries(root).filter(([path, value]) => /(?:^|\.)(?:raporTextByRapor|raporText|raporMetni|raporHtml|rapor|bulgu|bulgular|sonuc|sonucAciklama)$/i.test(path) && typeof value === 'string' && clean(value).length > 20);
    return radiologyTextFromRaw(candidates[0]?.[1] || '');
  };
  const fetchRadiologyReport = async (reportId) => {
    if (!reportId) return '';
    const payload = await apiGet(`/Ris/RisHizmetSonuc/getRisRaporSonucByRaporId/${encodeURIComponent(reportId)}`);
    return deepRadiologyText(payload?.data || payload || {});
  };
  const fetchImaging = async (result) => {
    const queries = [result.hastaGelisId ? { property: 'hastaGelisId', value: result.hastaGelisId } : null, result.hastaId ? { property: 'hastaId', value: result.hastaId } : null].filter(Boolean);
    if (!queries.length) throw new Error('hastaGelisId/hastaId bulunamadı');
    const rows = [];
    await runPool(queries, 2, async (query) => {
      const payload = await apiGet('/Ris/RisHizmetSonuc/getRisHizmetSonucInfoList', { filter: JSON.stringify([{ property: query.property, value: Number(query.value), type: 'Long', operator: '=' }]), page: 1, start: 0, limit: 500, sort: JSON.stringify([{ property: 'istemTarihi', direction: 'DESC' }]) });
      rows.push(...arrayData(payload));
    });
    const unique = rows.filter((row, index, all) => {
      const key = clean(firstValue(row.raporId, row.risOrderId, `${row.istemTarihi}|${row.risOrderKodAdi}`));
      return all.findIndex((other) => clean(firstValue(other.raporId, other.risOrderId, `${other.istemTarihi}|${other.risOrderKodAdi}`)) === key) === index;
    });
    const items = unique.map((row) => {
      const date = firstValue(row.istemTarihi, row.risKabulTarihi, row.raporOnayTarihi);
      return { id: clean(firstValue(row.risOrderId, row.id)), reportId: clean(row.raporId), tarih: formatDate(date), pod: pod(result.ameliyatTarihi, date), tetkik: clean(firstValue(row.risOrderKodAdi, row.hizmetKoduAdi, row.tetkikAdi)), çekimTarihi: formatDate(firstValue(row.cekimOnayTarihi, row.risKabulTarihi)), raporTarihi: formatDate(firstValue(row.raporOnayTarihi, row.onayTarihi)), rapor: radiologyTextFromRaw(firstValue(row.raporTextByRapor, row.raporText, row.rapor, row.bulgular, row.sonuc)), istemKlinikBilgi: multiline(firstValue(row.istemAciklama, row.klinikBilgi, row.endikasyon, row.aciklama)), fonetKaydı: `Radyoloji ${clean(firstValue(row.risOrderId, row.raporId)) || '(kimlik yok)'}`, fonetTarihi: formatDate(date) };
    }).filter((row) => inPostopWindow(result.ameliyatTarihi, row.tarih));
    await runPool(items.filter((item) => item.reportId), 3, async (item) => {
      const report = await fetchRadiologyReport(item.reportId);
      if (report) item.rapor = report;
    });
    return items;
  };

  const fetchSurgeries = async (result) => {
    if (!result.birimSevkId) throw new Error('birimSevkId bulunamadı');
    const payload = await apiGet(`/Klinik/Klinik/ameliyatIstekKlinikList/${encodeURIComponent(result.birimSevkId)}`);
    return arrayData(payload).map((row) => {
      const date = firstValue(row.baslangicTarihi, row.bitisTarihi, row.istekTarihi, row.etar);
      return { id: clean(row.id), tarih: formatDate(date), pod: pod(result.ameliyatTarihi, date), ameliyat: clean(firstValue(row.ameliyat1, row.ameliyat, row.ameliyatAdi)), birim: clean(firstValue(row.yapanBirim, row.isteyenBirim)), anestezi: clean(firstValue(row.anesteziSekli, row.anestezi?.adi)), fonetKaydı: `Ameliyat ${clean(row.id) || '(kimlik yok)'}`, fonetTarihi: formatDate(date) };
    }).filter((row) => row.tarih).sort((a, b) => dateMs(a.tarih) - dateMs(b.tarih));
  };

  const COMPLICATIONS = [
    { name: 'Anastomoz kaçağı', pattern: /anastomoz.{0,30}(kaçak|kacak|leak)/i },
    { name: 'Safra kaçağı', pattern: /(postop(?:eratif)?\s+)?safra.{0,30}(kaçak|kacak)|safralı\s+(gelen|dren)/i },
    { name: 'Kaçak (yeri belirtilmemiş)', pattern: /\b(kaçak|kacak|leak)\b/i },
    { name: 'Postoperatif kanama', pattern: /(postop|postoperatif|ameliyat sonrası).{0,30}kanama|hemoperiton/i },
    { name: 'Apse / koleksiyon', pattern: /\b(apse|abse|koleksiyon)\b/i },
    { name: 'Cerrahi alan enfeksiyonu', pattern: /cerrahi alan enfeks|yara yeri enfeks/i },
    { name: 'Yara ayrışması', pattern: /dehisens|evisserasyon|yara.{0,20}ayrış/i },
    { name: 'Fistül', pattern: /\b(fistül|fistul)\b/i },
    { name: 'İleus', pattern: /postop.{0,20}ileus|mekanik ileus/i },
    { name: 'Yeni postoperatif perforasyon', pattern: /(postop|postoperatif|ameliyat sonrası).{0,60}perforasyon.{0,30}(geliş|saptan|izlen|tespit|oluş)|perforasyon.{0,60}(postop|postoperatif|ameliyat sonrası).{0,30}(geliş|saptan|izlen|tespit|oluş)/i },
    { name: 'Sepsis', pattern: /sepsis|septik şok|septik sok/i },
    { name: 'Pnömoni', pattern: /pnömoni|pnomoni/i },
    { name: 'Plevral efüzyon', pattern: /plevral\s+(efüzyon|effüzyon|sıvı|mayi)/i },
    { name: 'Deliryum', pattern: /deliryum|tıbbi duruma sekonder delryum/i },
    { name: 'Tromboemboli', pattern: /pulmoner embol|derin ven trombo|tromboemboli/i },
    { name: 'Böbrek yetmezliği', pattern: /akut böbrek (hasarı|yetmezliği)|akut bobrek/i },
    { name: 'Solunum yetmezliği', pattern: /solunum yetmezliği|respiratuvar yetmezlik/i }
  ];
  const NEGATED_FINDING = /\b(yok|izlenmedi|saptanmadı|saptanmamıştır|tespit edilmedi|mevcut değil|düşünülmedi|ekarte edildi|lehine bulgu (?:yok|izlenmedi))\b/i;
  const UNCERTAIN_FINDING = /\?|\b(şüphe|suphe|olası|olasi|ön tanı|on tani|açısından değerlendiril|klinik korelasyon)\b/i;
  const HISTORICAL_FINDING = /(?:özgeçmiş|ozgecmis|öyküsünde|oykusunde|geçirilmiş|gecirilmis|daha önce|daha once|eski|operasyon öyküsü|operasyon oykusu|ameliyat öyküsü|ameliyat oykusu|geçmişte|gecmiste)|(?:gö|go)\s*:/i;
  const CURRENT_POSTOP_FINDING = /(?:postop|postoperatif|ameliyat sonrası|ameliyat sonrasi|yeni geliş|yeni gelis|gelişti|gelisti|saptandı|saptandi|tespit edildi|izlendi)/i;
  const findingContexts = (text, pattern) => multiline(text).split(/\n+|(?<=[.!?])\s+/).map(clean).filter((part) => pattern.test(part));
  const complicationCandidates = (result) => {
    const out = [];
    const inspect = (text, source, date, evidenceType = 'request') => {
      const value = multiline(text); if (!value) return;
      for (const { name, pattern } of COMPLICATIONS) {
        const contexts = findingContexts(value, pattern).filter((part) => !HISTORICAL_FINDING.test(part) || CURRENT_POSTOP_FINDING.test(part));
        if (!contexts.length || contexts.every((part) => NEGATED_FINDING.test(part))) continue;
        const positive = contexts.find((part) => !NEGATED_FINDING.test(part) && !UNCERTAIN_FINDING.test(part));
        const evidence = positive || contexts.find((part) => !NEGATED_FINDING.test(part));
        if (!evidence) continue;
        const confirmed = positive && /^(result|report)$/.test(evidenceType);
        const key = `${name}|${source}|${date}`;
        const candidate = { key, komplikasyon: name, tarih: date, pod: pod(result.ameliyatTarihi, date), fonetKaydı: source, fonetTarihi: date, kanıt: clip(evidence, 1200), doğrulama: confirmed ? 'Doğrulandı' : 'Şüpheli bulgu — morbiditeye sayılmaz', clavienDindo: confirmed ? 'Derecelendirilemedi' : '' };
        const existingIndex = out.findIndex((item) => item.key === key);
        if (existingIndex >= 0) {
          if (confirmed && out[existingIndex].doğrulama !== 'Doğrulandı') out[existingIndex] = candidate;
        } else out.push(candidate);
      }
    };
    result.konsültasyonlar.forEach((row) => {
      inspect(row.istem, row.fonetKaydı, row.fonetTarihi, 'request');
      inspect(row.sonuç, row.fonetKaydı, row.fonetTarihi, 'result');
    });
    result.görüntülemeler.forEach((row) => inspect(row.rapor, row.fonetKaydı, row.fonetTarihi, 'report'));
    result.yenidenAmeliyat.forEach((row) => inspect(row.ameliyat, row.fonetKaydı, row.fonetTarihi));
    const hasSpecificLeak = out.some((item) => /kaçağı$/i.test(item.komplikasyon));
    return out.filter((item) => item.komplikasyon !== 'Kaçak (yeri belirtilmemiş)' || !hasSpecificLeak).map(({ key, ...item }) => item);
  };

  const timelineText = (value, max = 650) => clip(multiline(value).replace(/\n+/g, ' · '), max);
  const clinicalTimeline = (result) => {
    const events = [];
    const add = (date, type, detail, source = '') => {
      const text = timelineText(detail); if (!text) return;
      const eventPod = pod(result.ameliyatTarihi, date);
      const prefix = `${formatDate(date) || 'Tarih yok'} · POD ${eventPod ?? '?'} · ${type}`;
      const line = `${prefix}: ${text}${source ? ` [${source}]` : ''}`;
      const key = norm(`${date}|${type}|${text}`); if (!events.some((item) => item.key === key)) events.push({ key, date, line });
    };
    add(result.ameliyatTarihi, 'Ameliyat', result.standartAmeliyatAdı || result.ameliyat, `Ameliyat ${result.surgeryRecordId || result.işlemNo}`);
    result.konsültasyonlar.forEach((item) => add(item.tarih, `Konsültasyon${item.birim ? ` (${item.birim})` : ''}`, [item.istem && `İstem: ${item.istem}`, item.sonuç && `Sonuç: ${item.sonuç}`].filter(Boolean).join('\n'), item.fonetKaydı));
    result.görüntülemeler.forEach((item) => add(item.tarih, `Görüntüleme (${item.tetkik || 'tetkik adı yok'})`, item.rapor || 'Rapor metni bulunamadı.', item.fonetKaydı));
    result.yenidenBaşvuruYatış.forEach((item) => add(item.tarih, 'Yeniden başvuru/yatış adayı', item.doğrulama, item.fonetKaydı));
    result.yenidenAmeliyat.forEach((item) => add(item.tarih, 'Yeniden ameliyat adayı', item.ameliyat, item.fonetKaydı));
    result.yoğunBakım.forEach((item) => add(item.tarih || result.yatışTarihi, 'Yoğun bakım', item.birim || 'Yoğun bakım kaydı', item.kaynak));
    if (result.ölüm.var) add(result.ölüm.tarih, 'Ölüm', 'Ölüm kaydı', result.ölüm.kaynak);
    events.sort((a, b) => (dateMs(a.date) || 0) - (dateMs(b.date) || 0) || a.line.localeCompare(b.line, 'tr'));
    const discharge = result.taburculukTarihi
      ? `${formatDate(result.taburculukTarihi)} · POD ${result.taburcuPOD ?? '?'} · Taburcu edildi.`
      : 'Taburculuk tarihi kaynakta bulunmadı; taburcu POD hesaplanamadı.';
    return clip([...events.map((item) => item.line), discharge].join('\n'), 32700);
  };

  async function runPool(items, concurrency, worker) {
    if (!items.length) return; let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (!state.stopped) { const index = cursor; cursor += 1; if (index >= items.length) return; await worker(items[index], index); }
    });
    await Promise.all(workers);
  }

  const addManual = (result, subject, detail, source = '') => {
    const item = { hasta: result.adSoyad, işlemNo: result.işlemNo, ameliyat: result.standartAmeliyatAdı, konu: subject, açıklama: detail, kaynak: source };
    result.manuelDoğrulama.push(item); state.manual.push(item);
  };
  const scanCase = async (item) => {
    const result = { ...item, yatışTarihi: '', taburculukTarihi: '', postoperatifYatışSüresi: null, taburcuPOD: null, komplikasyonlar: [], yoğunBakım: [], yenidenBaşvuruYatış: [], yenidenAmeliyat: [], ölüm: { var: false, tarih: '', kaynak: '' }, enYüksekClavienDindo: '', konsültasyonlar: [], görüntülemeler: [], manuelDoğrulama: [], veriHataları: [], morbiditeDurumu: 'Hayır', mortaliteDurumu: 'Hayır' };
    const safe = async (label, fn) => { try { return await fn(); } catch (error) { result.veriHataları.push(`${label}: ${clean(error.message)}`); return null; } };
    if (result.birimSevkId) {
      const [sevk, klinik] = await Promise.all([
        safe('Sevk', () => apiGet(`/Tibbi/HastaBirimSevk/getSevkUyariInfo/${encodeURIComponent(result.birimSevkId)}`)),
        safe('Klinik', () => apiGet(`/Klinik/Klinik/getKayit/${encodeURIComponent(result.birimSevkId)}`))
      ]);
      if (sevk) applyClinical(result, sevk, `HastaBirimSevk ${result.birimSevkId}`);
      if (klinik) applyClinical(result, klinik, `Klinik ${result.birimSevkId}`);
    }
    if (!result.birimSevkId && !result.hastaGelisId && !result.hastaId) result.veriHataları.push(`Hasta kimlik bağlantısı: ameliyat satırından hastaGelisId/birimSevkId/hastaId okunamadı.`);
    const historyRows = await safe('Hasta geçmişi', () => fetchPatientHistory(result)) || [];
    if (historyRows.length) {
      applyHistoryEpisode(result, historyRows);
      applyHistoryReadmission(result, historyRows);
    }
    const [consults, imaging, surgeries] = await Promise.all([safe('Konsültasyon', () => fetchConsultations(result)), safe('Radyoloji', () => fetchImaging(result)), safe('Ameliyat geçmişi', () => fetchSurgeries(result))]);
    result.konsültasyonlar = consults || []; result.görüntülemeler = imaging || [];
    const listedReoperations = (result.listeSonrakiAmeliyatlar || []).map((row) => ({ id: row.surgeryRecordId, tarih: row.ameliyatTarihi, pod: pod(result.ameliyatTarihi, row.ameliyatTarihi), ameliyat: row.standartAmeliyatAdı || row.ameliyat, birim: row.uzmanlık, anestezi: '', fonetKaydı: `Ameliyat listesi ${row.surgeryRecordId || row.işlemNo}`, fonetTarihi: row.ameliyatTarihi }));
    result.yenidenAmeliyat = [...(surgeries || []).filter((row) => row.pod != null && row.pod > 0 && row.pod <= WINDOW_DAYS && clean(row.id) !== clean(result.surgeryRecordId)), ...listedReoperations]
      .filter((row, index, all) => all.findIndex((other) => (clean(row.id) && clean(other.id) === clean(row.id)) || `${clean(other.tarih)}|${norm(other.ameliyat)}` === `${clean(row.tarih)}|${norm(row.ameliyat)}`) === index);
    result.komplikasyonlar = complicationCandidates(result);
    if (result.yatışTarihi && result.taburculukTarihi) {
      result.postoperatifYatışSüresi = pod(result.ameliyatTarihi, result.taburculukTarihi); result.taburcuPOD = result.postoperatifYatışSüresi;
      if (result.taburcuPOD < 0) addManual(result, 'Tarih çelişkisi', 'Taburculuk tarihi ameliyat tarihinden önce görünüyor.', `Klinik ${result.birimSevkId}`);
    } else result.veriHataları.push('Yatış veya taburculuk tarihi kaynak servislerden alınamadı.');
    if (result.ölüm.var) { result.mortaliteDurumu = 'Evet'; result.enYüksekClavienDindo = 'V'; }
    if (result.komplikasyonlar.some((x) => x.doğrulama === 'Doğrulandı')) {
      result.morbiditeDurumu = 'Evet';
      const percutaneousIntervention = result.görüntülemeler.some((row) => /perkütan.{0,50}(drenaj|kolanjiografi)|\bPTK\b/i.test(`${row.tetkik}\n${row.rapor}`));
      const complicationReoperation = result.yenidenAmeliyat.some((row) => result.komplikasyonlar.some((item) => item.doğrulama === 'Doğrulandı' && Math.abs((item.pod ?? -99) - (row.pod ?? 99)) <= 3));
      result.enYüksekClavienDindo ||= complicationReoperation ? 'IIIb' : percutaneousIntervention ? 'IIIa' : result.yoğunBakım.length ? 'IV' : 'Derecelendirilemedi';
    }
    result.kronolojikKlinikİzlem = clinicalTimeline(result);
    return result;
  };

  const keyOf = (item) => item.surgeryRecordId || [item.işlemNo, item.adSoyad, item.ameliyatTarihi, operationGroupKey(item.ameliyat)].join('|');
  const renderSummary = () => {
    if (!summaryEl?.isConnected) return;
    const found = new Map(state.results.map((result) => [keyOf(result), result])); const failed = new Map(state.errors.map((error) => [keyOf(error), error]));
    const rows = state.cases.map((item) => {
      const result = found.get(keyOf(item)); const error = failed.get(keyOf(item));
      const status = error ? 'Hata' : result ? (result.manuelDoğrulama.length ? 'Doğrula' : 'Tamam') : 'Bekliyor';
      const color = error ? '#5b2525' : result?.ölüm.var ? '#641f35' : result?.morbiditeDurumu !== 'Hayır' ? '#594a16' : result ? '#183b35' : '#243845';
      return `<tr style="background:${color}"><td>${html(item.adSoyad)}</td><td>${html(item.standartAmeliyatAdı)}</td><td>${result?.taburcuPOD ?? ''}</td><td>${result?.yenidenBaşvuruYatış?.length || '—'}</td><td>${result?.yenidenAmeliyat?.length || '—'}</td><td>${result?.konsültasyonlar?.length ?? ''}</td><td>${result?.görüntülemeler?.length ?? ''}</td><td>${html(status)}</td></tr>`;
    }).join('');
    summaryEl.innerHTML = `<table style="width:100%;border-collapse:collapse"><thead style="position:sticky;top:0;background:#126b82"><tr><th>Hasta</th><th>Ameliyat</th><th>POD</th><th>Yatış</th><th>Reop.</th><th>Kons.</th><th>Gör.</th><th>Durum</th></tr></thead><tbody>${rows}</tbody></table>`;
    summaryEl.querySelectorAll('th,td').forEach((cell) => { cell.style.padding = '4px'; cell.style.borderBottom = '1px solid #31505f'; cell.style.textAlign = cell.cellIndex < 2 ? 'left' : 'center'; });
  };

  const { raw: rawCases, unique: cases } = await collectCases(); state.cases = cases; state.metrics.total = cases.length;
  log(`${rawCases.length} satır → ${cases.length} tekil ameliyat. ${rawCases.length - cases.length} mükerrer liste satırı dışlandı.`); renderSummary();
  try {
    await runPool(cases, PATIENT_CONCURRENCY, async (item) => {
      if (panel.isConnected) statusEl.textContent = `Arka planda ${PATIENT_CONCURRENCY} paralel işçi: ${state.metrics.completed}/${cases.length} tamamlandı`;
      try {
        const result = await scanCase(item); state.results.push(result);
        log(`✓ ${item.adSoyad}: POD ${result.taburcuPOD ?? '?'} · ${result.konsültasyonlar.length} kons. · ${result.görüntülemeler.length} görüntüleme · ${result.yenidenAmeliyat.length} reop.`);
      } catch (error) {
        if (!state.stopped) { const failure = { ...item, hata: clean(error.message), durum: 'Taranamadı' }; state.errors.push(failure); log(`✗ ${item.adSoyad}: ${failure.hata}`); }
      } finally {
        state.metrics.completed += 1;
        if (panel.isConnected) { progressEl.style.width = `${Math.round((state.metrics.completed / cases.length) * 100)}%`; renderSummary(); }
      }
    });
  } finally {
    state.running = false;
    if (panel.isConnected) {
      const done = state.results.length + state.errors.length;
      statusEl.textContent = state.stopped ? `Durduruldu: ${done}/${cases.length}` : `Bitti: ${state.results.length} başarılı, ${state.errors.length} hata, ${state.manual.length} doğrulama notu / ${cases.length} ameliyat`;
      stopEl.disabled = true; xlsxEl.disabled = done === 0; jsonEl.disabled = done === 0; renderSummary();
    }
  }

  const groups = () => {
    const map = new Map();
    state.results.forEach((result) => {
      const key = operationGroupKey(result.standartAmeliyatAdı) || '(ameliyat adı eksik)';
      if (!map.has(key)) map.set(key, { ameliyat: result.standartAmeliyatAdı || result.ameliyat, hastalar: [] });
      map.get(key).hastalar.push(result);
    });
    return [...map.values()].map((group) => {
      const total = group.hastalar.length; const morbidity = group.hastalar.filter((x) => x.morbiditeDurumu === 'Evet').length; const mortality = group.hastalar.filter((x) => x.ölüm.var).length;
      const manual = group.hastalar.filter((x) => x.manuelDoğrulama.length).length;
      const dataIssue = group.hastalar.filter((x) => x.veriHataları.length).length;
      const cleanCount = group.hastalar.filter((x) => x.morbiditeDurumu === 'Hayır' && !x.ölüm.var).length;
      const rate = (count) => total ? (count * 100 / total).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) : '0';
      const narrative = `Toplam ${total} ${group.ameliyat} yapıldı. ${cleanCount} hastada doğrulanmış mortalite veya morbidite kanıtı saptanmadı. ${morbidity} hastada doğrulanmış morbidite gelişti (%${rate(morbidity)}). Mortalite: ${mortality} (%${rate(mortality)}). Veri eksiği olan: ${dataIssue}; gerçek klinik çelişki nedeniyle manuel doğrulama gereken: ${manual}.`;
      return { ...group, total, morbidity, mortality, manual, dataIssue, cleanCount, morbidityRate: rate(morbidity), mortalityRate: rate(mortality), narrative };
    }).sort((a, b) => b.total - a.total || a.ameliyat.localeCompare(b.ameliyat, 'tr'));
  };

  const download = (name, data, type) => { const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1500); };
  const xml = (value) => clip(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] || ''));
  const colName = (n) => { let value = ''; for (; n; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + ((n - 1) % 26)) + value; return value; };
  const sheetXml = (rows, widths, styleForRow = () => 0) => {
    const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => { const ref = `${colName(c + 1)}${r + 1}`; const style = r === 0 ? 1 : styleForRow(r, c); if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`; return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`; }).join('')}</row>`).join('');
    const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join(''); const last = `${colName(Math.max(1, widths.length))}${Math.max(1, rows.length)}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  };
  const crcTable = (() => { const table = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
  const crc32 = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u16 = (n) => [n & 255, (n >>> 8) & 255]; const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const zip = (files) => {
    const encoder = new TextEncoder(); const local = []; const central = []; let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const filename = encoder.encode(name); const data = encoder.encode(content); const crc = crc32(data);
      const localHeader = new Uint8Array([80,75,3,4,20,0,0,0,0,0,0,0,0,0,...u32(crc),...u32(data.length),...u32(data.length),...u16(filename.length),0,0,...filename,...data]); local.push(localHeader);
      const centralHeader = new Uint8Array([80,75,1,2,20,0,20,0,0,0,0,0,0,0,0,0,...u32(crc),...u32(data.length),...u32(data.length),...u16(filename.length),0,0,0,0,0,0,0,0,0,0,0,0,...u32(offset),...filename]); central.push(centralHeader); offset += localHeader.length;
    }
    const centralSize = central.reduce((sum, item) => sum + item.length, 0); const count = central.length;
    return new Blob([...local, ...central, new Uint8Array([80,75,5,6,0,0,0,0,...u16(count),...u16(count),...u32(centralSize),...u32(offset),0,0])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };

  const makeWorkbook = () => {
    const main = [['Standart Ameliyat', 'Toplam', 'Doğrulanmış Morbidite/Mortalite Yok', 'Morbidite', 'Morbidite %', 'Mortalite', 'Mortalite %', 'Veri Eksiği', 'Manuel Klinik Doğrulama', 'Rapor Cümlesi']];
    groups().forEach((group) => main.push([group.ameliyat, group.total, group.cleanCount, group.morbidity, group.morbidityRate, group.mortality, group.mortalityRate, group.dataIssue, group.manual, group.narrative]));
    const morbidity = [['Hasta', 'T.C. Kimlik No', 'Protokol/Yatış No', 'Yatış Tarihi', 'Ameliyat Tarihi', 'Standart Ameliyat', 'Taburculuk', 'Taburcu POD', 'Komplikasyonlar', 'Komplikasyon POD', 'En Yüksek Clavien–Dindo', 'Yoğun Bakım', 'Yeniden Yatış', 'Yeniden Ameliyat', 'FONET Kayıtları', 'FONET Tarihleri', 'Kanıt / Not', 'Kronolojik Klinik İzlem']];
    const mortality = [['Hasta', 'T.C. Kimlik No', 'Protokol/Yatış No', 'Ameliyat Tarihi', 'Standart Ameliyat', 'Ölüm Tarihi', 'FONET Kaynağı', 'Komplikasyonlar', 'En Yüksek Clavien–Dindo', 'Kronolojik Klinik İzlem']];
    const complications = [['Hasta', 'İşlem No', 'Standart Ameliyat', 'Komplikasyon', 'Tarih', 'POD', 'Clavien–Dindo', 'Doğrulama', 'FONET Kaydı', 'FONET Tarihi', 'Kanıt']];
    const suspects = [['Hasta', 'İşlem No', 'Standart Ameliyat', 'Şüpheli Bulgu', 'Tarih', 'POD', 'Durum', 'FONET Kaydı', 'Kanıt']];
    const consultations = [['Hasta', 'İşlem No', 'Ameliyat Tarihi', 'Konsültasyon Tarihi', 'POD', 'Birim', 'Hekim', 'İstem İçeriği', 'Konsültasyon Sonucu', 'Durum', 'FONET Kaydı']];
    const imaging = [['Hasta', 'İşlem No', 'Ameliyat Tarihi', 'İstem Tarihi', 'POD', 'Tetkik', 'Çekim Tarihi', 'Rapor Tarihi', 'İstem / Klinik Bilgi', 'Gerçek Radyoloji Raporu', 'FONET Kaydı']];
    const manual = [['Hasta', 'İşlem No', 'Ameliyat', 'Konu', 'Açıklama', 'Kaynak']];
    const dataIssues = [['Hasta', 'İşlem No', 'Ameliyat', 'Veri Sorunu']];
    state.results.forEach((result) => {
      result.komplikasyonlar.forEach((item) => {
        const row = [result.adSoyad, result.işlemNo, result.standartAmeliyatAdı, item.komplikasyon, item.tarih, item.pod ?? '', item.clavienDindo, item.doğrulama, item.fonetKaydı, item.fonetTarihi, item.kanıt];
        if (item.doğrulama === 'Doğrulandı') complications.push(row);
        else suspects.push([result.adSoyad, result.işlemNo, result.standartAmeliyatAdı, item.komplikasyon, item.tarih, item.pod ?? '', item.doğrulama, item.fonetKaydı, item.kanıt]);
      });
      const detailedCase = result.morbiditeDurumu === 'Evet' || result.ölüm.var;
      if (result.morbiditeDurumu === 'Evet') {
        const unique = (values) => [...new Set(values.filter((value) => clean(value) !== ''))].join(' | ');
        const confirmed = result.komplikasyonlar.filter((item) => item.doğrulama === 'Doğrulandı');
        morbidity.push([result.adSoyad, result.tcKimlikNo, result.protokolNo, result.yatışTarihi, result.ameliyatTarihi, result.standartAmeliyatAdı, result.taburculukTarihi, result.taburcuPOD ?? '', unique(confirmed.map((item) => item.komplikasyon)), unique(confirmed.map((item) => item.pod ?? '')), result.enYüksekClavienDindo, result.yoğunBakım.length ? 'Evet' : 'Hayır', result.yenidenBaşvuruYatış.length ? 'Evet' : 'Hayır', result.yenidenAmeliyat.length ? 'Evet' : 'Hayır', unique(confirmed.map((item) => item.fonetKaydı)), unique(confirmed.map((item) => item.fonetTarihi)), clip(confirmed.map((item) => `${item.komplikasyon}: ${item.kanıt}`).join('\n'), 32700), result.kronolojikKlinikİzlem]);
      }
      if (result.ölüm.var) mortality.push([result.adSoyad, result.tcKimlikNo, result.protokolNo, result.ameliyatTarihi, result.standartAmeliyatAdı, result.ölüm.tarih, result.ölüm.kaynak, [...new Set(result.komplikasyonlar.map((x) => x.komplikasyon))].join(' | '), result.enYüksekClavienDindo, result.kronolojikKlinikİzlem]);
      if (detailedCase) {
        result.konsültasyonlar.forEach((item) => consultations.push([result.adSoyad, result.işlemNo, result.ameliyatTarihi, item.tarih, item.pod ?? '', item.birim, item.hekim, item.istem, item.sonuç, item.durum, item.fonetKaydı]));
        result.görüntülemeler.forEach((item) => imaging.push([result.adSoyad, result.işlemNo, result.ameliyatTarihi, item.tarih, item.pod ?? '', item.tetkik, item.çekimTarihi, item.raporTarihi, item.istemKlinikBilgi, item.rapor, item.fonetKaydı]));
      }
      if (result.yenidenAmeliyat.length && result.morbiditeDurumu !== 'Evet') result.yenidenAmeliyat.forEach((item) => suspects.push([result.adSoyad, result.işlemNo, result.standartAmeliyatAdı, `Yeniden ameliyat: ${item.ameliyat}`, item.tarih, item.pod ?? '', 'Nedeni doğrulanmadı — morbiditeye sayılmaz', item.fonetKaydı, item.ameliyat]));
      result.veriHataları.forEach((issue) => dataIssues.push([result.adSoyad, result.işlemNo, result.standartAmeliyatAdı, issue]));
    });
    state.manual.forEach((item) => manual.push([item.hasta, item.işlemNo, item.ameliyat, item.konu, item.açıklama, item.kaynak]));
    state.errors.forEach((item) => manual.push([item.adSoyad, item.işlemNo, item.standartAmeliyatAdı, 'Tarama hatası', item.hata, `Ameliyat ${item.surgeryRecordId}`]));
    if (morbidity.length === 1) morbidity.push(['', '', '', '', '', '', '', '', 'Morbidite veya morbidite adayı kaydı yok', '', '', '', '', '', '', '', '', '']);
    if (mortality.length === 1) mortality.push(['', '', '', '', '', '', '', 'Mortalite kaydı yok', '', '']);
    if (complications.length === 1) complications.push(['', '', '', 'Doğrulanmış komplikasyon yok', '', '', '', '', '', '', '']);
    if (suspects.length === 1) suspects.push(['', '', '', 'Şüpheli bulgu yok', '', '', '', '', '']);
    if (manual.length === 1) manual.push(['', '', '', 'Yok', 'Manuel doğrulama notu yok', '']);
    if (dataIssues.length === 1) dataIssues.push(['', '', '', 'Veri sorunu yok']);
    const sheets = [
      ['Ana Rapor', main, [38,10,24,11,12,11,12,12,20,100], () => 0], ['Morbidite', morbidity, [24,16,17,19,19,38,19,12,38,18,22,14,16,16,34,24,80,120], () => 2],
      ['Mortalite', mortality, [24,16,17,19,38,19,30,60,22,120], () => 3],
      ['Komplikasyonlar', complications, [24,15,38,30,19,10,22,22,25,19,70], () => 2], ['Konsültasyonlar', consultations, [24,15,19,19,10,30,24,70,90,18,25], () => 4],
      ['Görüntülemeler', imaging, [24,15,19,19,10,40,19,19,70,100,25], () => 4], ['Şüpheli Bulgular', suspects, [24,15,38,35,19,10,35,28,80], () => 2],
      ['Veri Alınamadı', dataIssues, [24,15,38,100], () => 3], ['Manuel Klinik Doğrulama', manual, [24,15,38,28,90,45], () => 3]
    ];
    const files = {};
    files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
    files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet[0])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
    files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    files['xl/styles.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Calibri"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF126B82"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4CCCC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet[1], sheet[2], sheet[3]); });
    return zip(files);
  };

  xlsxEl.onclick = () => download(`HBYS-MM-${new Date().toISOString().slice(0, 10)}.xlsx`, makeWorkbook(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  jsonEl.onclick = () => download(`HBYS-MM-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ sürüm: VERSION, oluşturmaZamanı: new Date().toISOString(), pencere: `POD 0-${WINDOW_DAYS}`, saltOkunur: true, gruplar: groups(), sonuçlar: state.results, hatalar: state.errors, manuelDoğrulama: state.manual }, null, 2), 'application/json;charset=utf-8');
})().catch((error) => {
  alert(`HBYS MM arka plan tarayıcı başlatılamadı: ${error.message}`);
  if (window.__hbysMmScanner) window.__hbysMmScanner.running = false;
});
