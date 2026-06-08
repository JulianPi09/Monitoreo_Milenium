// Estado de la aplicación
let mentions = [];
let selectedMentions = new Set();
let currentPage = 1;
const PAGE_SIZE = 15;
let _confirmCallback = null;
let filterSentiments = new Set();
let filterNoteTypes = new Set();

const BRANDS_BY_COUNTRY = {
  argentina: ['Logitech', 'Herbalife', 'IFX', 'AWS'],
  colombia:  ['Makro', 'IFX', 'Burger King', 'Manpower'],
  peru:      ['Manpower', 'Herbalife', 'Logitech'],
  chile:     ['AWS', 'Logitech'],
  mexico:    ['Siigo']
};

// ===== TÍTULO AUTOMÁTICO =====

function getReportTitle() {
  const client  = document.getElementById('report-client').value.trim();
  const dateVal = document.getElementById('report-date').value; // "2026-05-22"
  let dateStr = '';
  if (dateVal) {
    const [y, m, d] = dateVal.split('-').map(Number);
    dateStr = new Date(y, m - 1, d).toLocaleDateString('es-AR', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  }
  if (client && dateStr) return `${client} · ${dateStr}`;
  if (client)  return client;
  if (dateStr) return dateStr;
  return 'Clipping de Medios';
}

// Versión segura para nombre de archivo PDF
function getReportFilename() {
  const title = getReportTitle();
  const safe = title
    .replace(/·/g, '_').replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-áéíóúüñÁÉÍÓÚÜÑ]/g, '')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return `Clipping_${safe}.pdf`;
}

function getEmailSubject() {
  return `[Clipping de Medios] ${getReportTitle()}`;
}

function updateTitlePreview() {
  const title = getReportTitle();
  document.getElementById('title-preview').textContent = title;
  // Sincronizar asunto solo si el usuario no lo editó manualmente
  const subjectEl = document.getElementById('email-subject');
  if (subjectEl && !subjectEl.dataset.manuallyEdited) {
    subjectEl.value = `[Clipping de Medios] ${title}`;
  }
}

// Inicializar fecha de hoy y preview
(function initTitleFields() {
  const today = new Date();
  const yyyy  = today.getFullYear();
  const mm    = String(today.getMonth() + 1).padStart(2, '0');
  const dd    = String(today.getDate()).padStart(2, '0');
  document.getElementById('report-date').value = `${yyyy}-${mm}-${dd}`;
  updateTitlePreview();
})();

document.getElementById('report-client').addEventListener('input',  updateTitlePreview);
document.getElementById('report-date').addEventListener('change', updateTitlePreview);

// Inicializar selectores en cascada de país/marca
onCountryChange();

// ===== PARSEO TALKWALKER CSV =====

// Botón "Parsear CSV" — re-procesa el último archivo subido
document.getElementById('btn-parse').addEventListener('click', () => {
  if (!lastUploadedCSV.trim()) {
    alert('Subí el archivo CSV de TalkWalker con el botón de arriba.');
    return;
  }
  runCSVParse(lastUploadedCSV);
});

// Subir archivo — usa FileReader con UTF-8 explícito para evitar Ã©, Ã³, etc.
document.getElementById('csv-file-input').addEventListener('change', handleFileUpload);

const uploadZone = document.getElementById('csv-upload-zone');
uploadZone.addEventListener('click', () => document.getElementById('csv-file-input').click());
uploadZone.addEventListener('dragover',  (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readFileAsUTF8(file);
});

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (file) readFileAsUTF8(file);
}

let lastUploadedCSV = '';

function readFileAsUTF8(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    lastUploadedCSV = text;
    // Actualizar indicador visual del archivo
    const nameEl = document.getElementById('csv-file-name');
    nameEl.textContent = `✓ ${file.name}`;
    nameEl.classList.remove('hidden');
    uploadZone.classList.add('has-file');
    // Parsear automáticamente
    runCSVParse(text);
  };
  reader.onerror = () => {
    alert('Error al leer el archivo. Intentá subirlo nuevamente.');
  };
  // UTF-8 explícito: evita que Windows o el navegador reinterpreten como Latin-1
  reader.readAsText(file, 'UTF-8');
}

// Lógica central de parseo — recibe el texto crudo (desde textarea o FileReader)
function runCSVParse(rawText) {
  // Eliminar BOM (Byte Order Mark) que Excel/Windows agrega a veces al inicio del archivo
  const raw = rawText.replace(/^﻿/, '').trim();
  if (!raw) {
    alert('El contenido está vacío.');
    return;
  }

  let parsed;
  try {
    const rows = parseCSV(raw);
    if (rows.length < 2) throw new Error('El CSV debe tener al menos una fila de encabezados y una mención');

    // Primera fila = encabezados; construir mapa de índices (tolerante a espacios y mayúsculas)
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const col = (name) => headers.indexOf(name.toLowerCase());

    const iTitle      = col('title');
    const iSource     = col('extra_source_attributes.name');
    const iPublished  = col('published');
    const iSnippet    = col('content_snippet');
    const iContent    = col('content');
    const iTitleSnippet = col('title_snippet');
    const iUrl        = col('url');
    const iSentiment  = col('sentiment');
    const iReach      = col('reach');
    const iEngagement = col('engagement');
    const iTagsCustomer = col('tags_customer');

    // Validar que al menos title o url estén presentes
    if (iTitle === -1 && iUrl === -1) {
      throw new Error('No se encontraron las columnas esperadas. Verificá que el CSV tenga encabezados "title" y "url".');
    }

    const get = (row, idx) => (idx !== -1 && idx < row.length) ? row[idx].trim() : '';

    // Configuración de la marca activa: palabras clave y voceros para detección automática (exclusivo del Excel)
    const activeBrandConfig = getActiveBrandTags();
    const keywordList = parseCommaList(activeBrandConfig && activeBrandConfig.palabrasClave);
    const spokespeopleList = parseCommaList(activeBrandConfig && activeBrandConfig.voceros);

    parsed = rows.slice(1)
      .filter(row => row.some(cell => cell.trim() !== '')) // ignorar filas vacías
      .map((row, idx) => {
        // Sentimiento: llega como string ("-5", "0", "5")
        const rawSentiment = parseInt(get(row, iSentiment), 10);
        let sentiment = 'neutral';
        if (!isNaN(rawSentiment)) {
          if (rawSentiment > 0) sentiment = 'positive';
          else if (rawSentiment < 0) sentiment = 'negative';
        }

        // Fecha: formato dd/mm/yy hh:mm:ss
        const dateRaw = get(row, iPublished);
        const date = dateRaw ? parseTWDate(dateRaw) : '';

        // Alcance e interacciones
        const reachRaw = get(row, iReach);
        const engRaw   = get(row, iEngagement);
        const reach      = reachRaw !== '' ? Number(reachRaw.replace(/\./g, '').replace(/,/g, '')) : null;
        const engagement = engRaw   !== '' ? Number(engRaw.replace(/\./g, '').replace(/,/g, ''))   : null;

        const sourceVal = get(row, iSource) || extractDomain(get(row, iUrl)) || '';

        // Detección automática de visibilidad y voceros: revisa title+title_snippet (lado titular) y content+content_snippet (lado contenido) (exclusivo del Excel)
        const titleText = get(row, iTitle);
        const titleSideText = `${titleText} ${get(row, iTitleSnippet)}`;
        const contentSideText = `${get(row, iContent)} ${get(row, iSnippet)}`;
        const visibilidad = detectVisibilidad(titleSideText, contentSideText, keywordList);
        const vocero = detectVocero(titleSideText, contentSideText, spokespeopleList);

        return {
          id: `m_${idx}_${Date.now()}`,
          title:       titleText || 'Sin título',
          source:      sourceVal,
          date,
          description: get(row, iSnippet),
          link:        get(row, iUrl),
          sentiment,
          noteType:    'espontanea',
          reach:       (!isNaN(reach) && reach !== null)           ? reach      : null,
          engagement:  (!isNaN(engagement) && engagement !== null) ? engagement : null,
          tagsCustomer: get(row, iTagsCustomer),
          visibilidad,
          vocero,
        };
      });

    if (parsed.length === 0) throw new Error('No se encontraron menciones en el CSV');

    // Ordenar de mayor a menor engagement (nulls al final)
    parsed.sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1));

  } catch (err) {
    showStatus('send-status', 'error', `Error al parsear el CSV: ${err.message}. Verificá que sea un export válido de TalkWalker.`);
    document.getElementById('step-send').classList.add('hidden');
    return;
  }

  mentions = parsed;
  selectedMentions.clear();
  currentPage = 1;
  filterSentiments.clear();
  filterNoteTypes.clear();
  ['positive', 'neutral', 'negative', 'espontanea', 'proactiva', 'reactiva'].forEach(v => {
    const el = document.getElementById(`filt-${v}`);
    if (el) el.classList.remove('filter-active');
  });
  const filterPanel = document.getElementById('filter-panel');
  if (filterPanel) filterPanel.classList.add('hidden');
  renderMentions();
  document.getElementById('step-mentions').classList.remove('hidden');
  document.getElementById('step-mentions').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Parser CSV robusto — respeta RFC 4180:
// · Campos entre comillas dobles pueden contener comas y saltos de línea
// · "" dentro de un campo entrecomillado = comilla literal
function parseCSV(text) {
  const rows = [];
  // Normalizar saltos de línea
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const n = src.length;
  let i = 0;

  while (i < n) {
    const row = [];

    rowLoop: while (true) {
      let field = '';

      if (i < n && src[i] === '"') {
        // Campo entrecomillado
        i++; // saltar comilla de apertura
        while (i < n) {
          if (src[i] === '"') {
            if (i + 1 < n && src[i + 1] === '"') {
              field += '"';   // "" → comilla literal
              i += 2;
            } else {
              i++;            // saltar comilla de cierre
              break;
            }
          } else {
            field += src[i++];
          }
        }
      } else {
        // Campo sin comillas — leer hasta coma o salto de línea
        while (i < n && src[i] !== ',' && src[i] !== '\n') {
          field += src[i++];
        }
      }

      row.push(field);

      if (i >= n) { break rowLoop; }          // fin del texto
      if (src[i] === ',') { i++; continue; }  // siguiente campo
      if (src[i] === '\n') { i++; break rowLoop; } // fin de fila
    }

    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  return rows;
}

// Parsear fecha TalkWalker: dd/mm/yy hh:mm:ss o dd/mm/yyyy hh:mm:ss
function parseTWDate(str) {
  if (!str) return '';
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) {
    // Intentar formatDate genérico como fallback
    return formatDate(str);
  }
  const [, dd, mm, yy, hh, min, ss] = m;
  const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10);
  const d = new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10),
                     parseInt(hh, 10), parseInt(min, 10), parseInt(ss, 10));
  return formatDate(d);
}

// ===== DETECCIÓN AUTOMÁTICA: VISIBILIDAD Y VOCEROS (exclusivo del Excel) =====

function parseCommaList(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Listas de etiquetas TalkWalker (separadas por coma, punto y coma o barra vertical), igual que en server.js
function parseTagList(str) {
  return (str || '').split(/[,;|]/).map(t => t.trim()).filter(Boolean);
}

// Filtra las menciones que pertenecen a la sección MARCA según las etiquetas de marca configuradas (tags_customer).
// Si no hay etiquetas de marca configuradas para la marca activa, devuelve todas las menciones sin filtrar.
function filterMentionsBySectionMarca(allMentions) {
  const brandConfig = getActiveBrandTags();
  const brandTagList = parseTagList(brandConfig && brandConfig.brand);
  if (!brandTagList.length) return allMentions;
  return allMentions.filter(m => {
    const mentionTags = parseTagList(m.tagsCustomer);
    return mentionTags.some(mt => brandTagList.some(ct => mt.toLowerCase() === ct.toLowerCase()));
  });
}

function detectVisibilidad(title, content, keywords) {
  if (!keywords.length) return '';
  const titleLower = (title || '').toLowerCase();
  const contentLower = (content || '').toLowerCase();
  const inTitle = keywords.some(k => titleLower.includes(k.toLowerCase()));
  const inContent = keywords.some(k => contentLower.includes(k.toLowerCase()));
  if (inTitle && inContent) return 'En titular y contenido';
  if (inTitle) return 'En titular';
  if (inContent) return 'En contenido';
  return '';
}

function detectVocero(title, content, spokespeople) {
  if (!spokespeople.length) return '';
  const text = `${title || ''} ${content || ''}`.toLowerCase();
  const found = spokespeople.filter(name => text.includes(name.toLowerCase()));
  return found.join(', ');
}

// ===== FILTROS =====

function getDisplayMentions() {
  if (filterSentiments.size === 0 && filterNoteTypes.size === 0) return mentions;
  return mentions.filter(m => {
    const sentOk = filterSentiments.size === 0 || filterSentiments.has(m.sentiment);
    const noteOk = filterNoteTypes.size === 0 || filterNoteTypes.has(m.noteType || 'espontanea');
    return sentOk && noteOk;
  });
}

function toggleFilterPanel() {
  document.getElementById('filter-panel').classList.toggle('hidden');
}

function toggleFilterSentiment(value) {
  if (filterSentiments.has(value)) filterSentiments.delete(value);
  else filterSentiments.add(value);
  document.getElementById(`filt-${value}`).classList.toggle('filter-active', filterSentiments.has(value));
}

function toggleFilterNoteType(value) {
  if (filterNoteTypes.has(value)) filterNoteTypes.delete(value);
  else filterNoteTypes.add(value);
  document.getElementById(`filt-${value}`).classList.toggle('filter-active', filterNoteTypes.has(value));
}

function applyFilter() {
  currentPage = 1;
  renderMentions();
  document.getElementById('filter-panel').classList.add('hidden');
}

function clearFilter() {
  filterSentiments.clear();
  filterNoteTypes.clear();
  ['positive', 'neutral', 'negative'].forEach(v =>
    document.getElementById(`filt-${v}`).classList.remove('filter-active')
  );
  ['espontanea', 'proactiva', 'reactiva'].forEach(v =>
    document.getElementById(`filt-${v}`).classList.remove('filter-active')
  );
  currentPage = 1;
  renderMentions();
  document.getElementById('filter-panel').classList.add('hidden');
}

// ===== RENDERIZADO DE MENCIONES =====

function totalPages() {
  return Math.max(1, Math.ceil(getDisplayMentions().length / PAGE_SIZE));
}

function renderMentions() {
  const list = document.getElementById('mentions-list');
  const count = document.getElementById('mentions-count');

  const display = getDisplayMentions();
  const total = display.length;
  const filterOn = filterSentiments.size > 0 || filterNoteTypes.size > 0;
  const pages = totalPages();
  if (currentPage > pages) currentPage = pages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, total);
  const pageMentions = display.slice(start, end);

  if (total === 0) {
    count.textContent = filterOn
      ? `0 menciones · Filtro activo (${mentions.length} en total)`
      : '0 menciones encontradas';
  } else if (total <= PAGE_SIZE) {
    const base = `${total} mención${total !== 1 ? 'es' : ''} encontrada${total !== 1 ? 's' : ''}`;
    count.textContent = filterOn ? `${base} · Filtro activo` : base;
  } else {
    count.textContent = filterOn
      ? `${total} de ${mentions.length} menciones · Mostrando ${start + 1}–${end}`
      : `${total} menciones encontradas · Mostrando ${start + 1}–${end}`;
  }

  if (total === 0) {
    list.innerHTML = filterOn
      ? '<p style="color:#888;font-size:14px;text-align:center;padding:32px 0;">No hay menciones que coincidan con el filtro activo.</p>'
      : '<p style="color:#888;font-size:14px;text-align:center;padding:32px 0;">No hay menciones. Podés volver a parsear el CSV.</p>';
    updateBulkBar();
    renderPagination();
    return;
  }

  list.innerHTML = pageMentions.map(m => {
    const statsHtml = (m.reach != null || m.engagement != null) ? `
      <div class="mention-stats">
        ${m.reach != null ? `<span class="mention-stat"><span class="stat-label">Alcance</span> ${formatNumber(m.reach)}</span>` : ''}
        ${m.engagement != null ? `<span class="mention-stat"><span class="stat-label">Interacciones</span> ${formatNumber(m.engagement)}</span>` : ''}
      </div>` : '';

    const isSelected = selectedMentions.has(m.id);
    const noteType = m.noteType || 'espontanea';

    return `
    <div class="mention-card${isSelected ? ' selected' : ''}" data-sentiment="${m.sentiment}" data-id="${m.id}">
      <div class="mention-check-col">
        <input type="checkbox" class="mention-checkbox" onchange="toggleMentionSelect('${m.id}')" ${isSelected ? 'checked' : ''}>
      </div>
      <div class="mention-border"></div>
      <div class="mention-body">
        <div class="mention-meta">
          ${m.source ? `<span class="mention-source">${escapeHTML(m.source)}</span>` : ''}
          ${m.date ? `<span class="mention-date">${escapeHTML(m.date)}</span>` : ''}
        </div>
        <div class="mention-title">${escapeHTML(m.title)}</div>
        ${m.description ? `<div class="mention-desc">${escapeHTML(m.description)}</div>` : ''}
        ${statsHtml}
        ${m.link ? `<a class="mention-link" href="${escapeHTML(m.link)}" target="_blank" rel="noopener">Ver nota →</a>` : ''}
      </div>
      <div class="mention-actions">
        <select class="sentiment-select" onchange="setSentiment('${m.id}', this.value)">
          <option value="neutral" ${m.sentiment === 'neutral' ? 'selected' : ''}>Neutral</option>
          <option value="positive" ${m.sentiment === 'positive' ? 'selected' : ''}>Positiva</option>
          <option value="negative" ${m.sentiment === 'negative' ? 'selected' : ''}>Negativa</option>
        </select>
        <select class="notetype-select" onchange="setNoteType('${m.id}', this.value)">
          <option value="espontanea" ${noteType === 'espontanea' ? 'selected' : ''}>Espontánea</option>
          <option value="proactiva" ${noteType === 'proactiva' ? 'selected' : ''}>Proactiva</option>
          <option value="reactiva" ${noteType === 'reactiva' ? 'selected' : ''}>Reactiva</option>
        </select>
        <button class="btn-delete" onclick="deleteMention('${m.id}')" title="Eliminar mención">✕</button>
      </div>
    </div>`;
  }).join('');

  updateBulkBar();
  renderPagination();
}

function renderPagination() {
  const container = document.getElementById('pagination');
  const pages = totalPages();

  if (pages <= 1) {
    container.innerHTML = '';
    return;
  }

  const prev = currentPage > 1;
  const next = currentPage < pages;

  let nums = '';
  for (let i = 1; i <= pages; i++) {
    nums += `<button class="btn btn-sm page-btn${i === currentPage ? ' page-btn-active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  container.innerHTML = `
    <div class="pagination">
      <button class="btn btn-sm page-btn" onclick="goToPage(${currentPage - 1})" ${prev ? '' : 'disabled'}>← Anterior</button>
      ${nums}
      <button class="btn btn-sm page-btn" onclick="goToPage(${currentPage + 1})" ${next ? '' : 'disabled'}>Siguiente →</button>
    </div>`;
}

function goToPage(n) {
  currentPage = Math.max(1, Math.min(n, totalPages()));
  renderMentions();
  document.getElementById('step-mentions').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setSentiment(id, value) {
  const m = mentions.find(x => x.id === id);
  if (m) {
    m.sentiment = value;
    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) card.dataset.sentiment = value;
  }
}

function setAllSentiment(value) {
  mentions.forEach(m => m.sentiment = value);
  renderMentions();
}

function deleteMention(id) {
  mentions = mentions.filter(m => m.id !== id);
  selectedMentions.delete(id);
  renderMentions();
}

function setNoteType(id, value) {
  const m = mentions.find(x => x.id === id);
  if (m) m.noteType = value;
}

function setAllNoteType(value) {
  mentions.forEach(m => m.noteType = value);
  renderMentions();
}

function toggleMentionSelect(id) {
  if (selectedMentions.has(id)) {
    selectedMentions.delete(id);
  } else {
    selectedMentions.add(id);
  }
  const card = document.querySelector(`[data-id="${id}"]`);
  if (card) card.classList.toggle('selected', selectedMentions.has(id));
  updateBulkBar();
}

function selectAll() {
  mentions.forEach(m => selectedMentions.add(m.id));
  renderMentions();
}

function selectPage() {
  const start = (currentPage - 1) * PAGE_SIZE;
  mentions.slice(start, start + PAGE_SIZE).forEach(m => selectedMentions.add(m.id));
  renderMentions();
}

function deselectAll() {
  selectedMentions.clear();
  renderMentions();
}

// ===== CONFIRMACIÓN =====

function showConfirm(message, callback) {
  _confirmCallback = callback;
  document.getElementById('confirm-msg').textContent = message;
  document.getElementById('confirm-dialog').classList.remove('hidden');
}

function confirmAction() {
  const cb = _confirmCallback;
  closeConfirm();
  if (cb) cb();
}

function closeConfirm() {
  document.getElementById('confirm-dialog').classList.add('hidden');
  _confirmCallback = null;
}

function confirmSetAllSentiment(value) {
  const labels = { positive: 'Positiva', neutral: 'Neutral', negative: 'Negativa' };
  showConfirm(`¿Marcar las ${mentions.length} menciones como "${labels[value]}"?`, () => setAllSentiment(value));
}

function confirmSetAllNoteType(value) {
  const labels = { espontanea: 'Espontánea', proactiva: 'Proactiva', reactiva: 'Reactiva' };
  showConfirm(`¿Marcar las ${mentions.length} menciones como "${labels[value]}"?`, () => setAllNoteType(value));
}

function confirmBulkSetSentiment(value) {
  const labels = { positive: 'Positiva', neutral: 'Neutral', negative: 'Negativa' };
  const n = selectedMentions.size;
  showConfirm(`¿Marcar las ${n} menciones seleccionadas como "${labels[value]}"?`, () => bulkSetSentiment(value));
}

function confirmBulkSetNoteType(value) {
  const labels = { espontanea: 'Espontánea', proactiva: 'Proactiva', reactiva: 'Reactiva' };
  const n = selectedMentions.size;
  showConfirm(`¿Marcar las ${n} menciones seleccionadas como "${labels[value]}"?`, () => bulkSetNoteType(value));
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const n = selectedMentions.size;
  if (n === 0) {
    bar.classList.add('hidden');
  } else {
    bar.classList.remove('hidden');
    document.getElementById('bulk-count').textContent = `${n} seleccionada${n !== 1 ? 's' : ''}`;
  }
}

function bulkSetSentiment(value) {
  selectedMentions.forEach(id => {
    const m = mentions.find(x => x.id === id);
    if (m) m.sentiment = value;
  });
  renderMentions();
}

function bulkSetNoteType(value) {
  selectedMentions.forEach(id => {
    const m = mentions.find(x => x.id === id);
    if (m) m.noteType = value;
  });
  renderMentions();
}

// ===== PASO 2 → 3 =====

document.getElementById('btn-continue').addEventListener('click', () => {
  if (mentions.length === 0) {
    alert('No hay menciones para enviar. Parseá el CSV primero.');
    return;
  }
  document.getElementById('step-send').classList.remove('hidden');
  document.getElementById('step-send').scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Prellenar asunto si no fue editado manualmente
  const subjectEl = document.getElementById('email-subject');
  if (!subjectEl.dataset.manuallyEdited) {
    subjectEl.value = getEmailSubject();
  }
  loadSmtpConfig();
});

// Marcar el asunto como editado manualmente si el usuario escribe
document.getElementById('email-subject').addEventListener('input', function () {
  this.dataset.manuallyEdited = 'true';
});

// ===== SMTP CONFIG (persiste en localStorage) =====

function toggleSmtp() {
  const fields = document.getElementById('smtp-fields');
  const arrow = document.getElementById('toggle-arrow');
  fields.classList.toggle('hidden');
  arrow.textContent = fields.classList.contains('hidden') ? '▼' : '▲';
}

function saveSmtpConfig() {
  const config = getSmtpConfig();
  localStorage.setItem('smtp_config', JSON.stringify(config));
  const confirm = document.getElementById('smtp-saved');
  confirm.classList.remove('hidden');
  setTimeout(() => confirm.classList.add('hidden'), 2000);
}

function loadSmtpConfig() {
  const saved = localStorage.getItem('smtp_config');
  if (!saved) return;
  try {
    const config = JSON.parse(saved);
    if (config.host) document.getElementById('smtp-host').value = config.host;
    if (config.port) document.getElementById('smtp-port').value = config.port;
    if (config.user) document.getElementById('smtp-user').value = config.user;
    if (config.pass) document.getElementById('smtp-pass').value = config.pass;
  } catch {}
}

function getSmtpConfig() {
  return {
    host: document.getElementById('smtp-host').value.trim(),
    port: document.getElementById('smtp-port').value.trim() || '587',
    user: document.getElementById('smtp-user').value.trim(),
    pass: document.getElementById('smtp-pass').value
  };
}

// ===== PROGRAMAR =====

function toggleSchedule() {
  const checked = document.getElementById('schedule-checkbox').checked;
  const dateInput = document.getElementById('schedule-at');
  dateInput.classList.toggle('hidden', !checked);
  const btn = document.getElementById('btn-send');
  btn.textContent = checked ? 'Programar envío' : 'Enviar clipping';
  if (checked && !dateInput.value) {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 30);
    dateInput.value = now.toISOString().slice(0, 16);
  }
}

// ===== ENVIAR =====

async function sendClipping() {
  const recipients = document.getElementById('recipients').value.trim();
  if (!recipients) { alert('Ingresá al menos un email destinatario.'); return; }

  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
    alert('Completá la configuración SMTP (servidor, email y contraseña).'); return;
  }

  const title   = getReportTitle();
  const subject = document.getElementById('email-subject').value.trim() || getEmailSubject();
  const isScheduled = document.getElementById('schedule-checkbox').checked;
  const scheduledAt = document.getElementById('schedule-at').value;

  const btn = document.getElementById('btn-send');
  btn.disabled = true;
  btn.textContent = isScheduled ? 'Programando...' : 'Enviando...';

  const payload = { mentions, recipients, title, subject, smtpConfig, brandLogo: getActiveBrandLogo(), brandTags: getActiveBrandTags() };
  const endpoint = isScheduled ? '/api/schedule' : '/api/send';
  if (isScheduled) payload.scheduledAt = scheduledAt;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showStatus('send-status', 'success', data.message);
    } else {
      showStatus('send-status', 'error', data.error || 'Error desconocido.');
    }
  } catch (err) {
    showStatus('send-status', 'error', `No se pudo conectar con el servidor: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = isScheduled ? 'Programar envío' : 'Enviar clipping';
  }
}

// ===== DESCARGAR PDF =====

async function downloadPDF() {
  if (mentions.length === 0) { alert('No hay menciones para generar el PDF.'); return; }
  const title    = getReportTitle();
  const filename = getReportFilename();
  const btn = document.getElementById('btn-pdf');
  btn.disabled = true;
  btn.textContent = 'Generando PDF…';

  try {
    const res = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mentions, title, brandLogo: getActiveBrandLogo(), brandTags: getActiveBrandTags() })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Error HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Error al generar PDF: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Descargar PDF';
  }
}

// ===== PREVIEW =====

async function previewEmail() {
  const title = getReportTitle();
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mentions, title, brandLogo: getActiveBrandLogo(), brandTags: getActiveBrandTags() })
    });
    const html = await res.text();
    const frame = document.getElementById('preview-frame');
    frame.srcdoc = html;
    document.getElementById('preview-modal').classList.remove('hidden');
  } catch (err) {
    alert(`Error al generar la vista previa: ${err.message}`);
  }
}

function closePreview() {
  document.getElementById('preview-modal').classList.add('hidden');
}

// ===== UTILIDADES =====

function formatDate(input) {
  try {
    const d = input instanceof Date ? input : new Date(input);
    return d.toLocaleDateString('es-AR', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch { return String(input); }
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('es-AR');
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch { return ''; }
}

function stripHTML(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== NAVEGACIÓN DE PANTALLAS =====

function showScreen(screen) {
  ['report', 'brand-config', 'mailing', 'export', 'history'].forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== screen);
  });

  ['brand-config', 'mailing', 'export', 'history'].forEach(s => {
    const el = document.getElementById(`nav-${s}`);
    if (el) el.classList.toggle('active', s === screen);
  });

  const newReportBtn = document.getElementById('nav-report');
  if (newReportBtn) newReportBtn.classList.toggle('active', screen === 'report');

  const backBtn = document.getElementById('btn-back-to-report');
  if (backBtn) backBtn.classList.toggle('hidden', screen === 'report');

  if (screen === 'brand-config') loadBrandConfigScreen();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function onCountryChange() {
  const countryEl = document.getElementById('sidebar-country');
  const brandEl = document.getElementById('sidebar-brand');
  if (!countryEl || !brandEl) return;
  const brands = BRANDS_BY_COUNTRY[countryEl.value] || [];
  brandEl.innerHTML = brands
    .map(b => `<option value="${b.toLowerCase().replace(/[\s&]/g, '-')}">${b}</option>`)
    .join('');
  updateScreenTitles();
  if (!document.getElementById('screen-brand-config').classList.contains('hidden')) loadBrandConfigScreen();
}

function onBrandChange() {
  updateScreenTitles();
  if (!document.getElementById('screen-brand-config').classList.contains('hidden')) loadBrandConfigScreen();
}

function updateScreenTitles() {
  const countryEl = document.getElementById('sidebar-country');
  const brandEl = document.getElementById('sidebar-brand');
  if (!countryEl || !brandEl) return;
  const countryName = countryEl.options[countryEl.selectedIndex]?.text || '';
  const brandName = brandEl.options[brandEl.selectedIndex]?.text || '';
  const suffix = (countryName && brandName) ? ` — ${countryName} · ${brandName}` : '';
  const screens = {
    'history-title':      'Historial de reportes',
    'brand-config-title': 'Configuración de marca',
    'mailing-title':      'Listas de correo',
    'export-title':       'Exportar datos'
  };
  Object.entries(screens).forEach(([id, base]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = base + suffix;
  });

  // Ajuste 1: autocompletar campo Cliente del Paso 1
  const clientEl = document.getElementById('report-client');
  if (clientEl) {
    clientEl.value = brandName;
    updateTitlePreview();
  }
}

function exportToExcel() {
  if (!mentions || mentions.length === 0) {
    alert('No hay datos cargados. Primero procesá un CSV en el Paso 1.');
    return;
  }

  const countryEl = document.getElementById('sidebar-country');
  const countryName = countryEl ? (countryEl.options[countryEl.selectedIndex]?.text || '') : '';

  const sentLabel = s => s === 'positive' ? 'Positiva' : s === 'negative' ? 'Negativa' : 'Neutral';
  const noteLabel = n => n === 'proactiva' ? 'Proactiva' : n === 'reactiva' ? 'Reactiva' : 'Espontánea';

  const exportMentions = filterMentionsBySectionMarca(mentions);

  const rows = exportMentions.map(m => ({
    'Fecha':         m.date        || '',
    'Título':        m.title       || '',
    'Link':          m.link        || '',
    'Medio':         m.source      || '',
    'País':          countryName,
    'Sentimiento':   sentLabel(m.sentiment),
    'Tipo de nota':  noteLabel(m.noteType),
    'Vocero':        m.vocero       || '',
    'Visibilidad':   m.visibilidad  || '',
    'Alcance':       m.reach       ?? '',
    'Interacciones': m.engagement  ?? ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Menciones');

  const brandEl = document.getElementById('sidebar-brand');
  const brandName = brandEl ? (brandEl.options[brandEl.selectedIndex]?.text || '') : '';
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `Clipping_${brandName}_${countryName}_${dateStr}.xlsx`.replace(/\s+/g, '_');

  XLSX.writeFile(wb, filename);
}

function saveConfigSection(confirmId) {
  const el = document.getElementById(confirmId);
  if (!el) return;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2500);
}

// ===== CONFIGURACIÓN DE MARCA: persistencia en localStorage =====

function getBrandStorageSuffix() {
  const countryEl = document.getElementById('sidebar-country');
  const brandEl = document.getElementById('sidebar-brand');
  if (!countryEl || !brandEl || !countryEl.value || !brandEl.value) return null;
  return `${countryEl.value}_${brandEl.value}`;
}

// Logo de la marca activa (país/marca del sidebar), en base64, para incluir en el encabezado del reporte
function getActiveBrandLogo() {
  const suffix = getBrandStorageSuffix();
  if (!suffix) return null;
  return localStorage.getItem(`brandLogo_${suffix}`);
}

// Etiquetas configuradas para la marca activa (país/marca del sidebar), para agrupar las menciones del reporte
function getActiveBrandTags() {
  const suffix = getBrandStorageSuffix();
  if (!suffix) return null;
  const saved = localStorage.getItem(`brandConfig_${suffix}`);
  return saved ? JSON.parse(saved) : null;
}

// Lee la configuración guardada de la marca activa y aplica los cambios indicados, preservando el resto de campos
function updateActiveBrandConfig(changes) {
  const suffix = getBrandStorageSuffix();
  if (!suffix) return;
  const saved = localStorage.getItem(`brandConfig_${suffix}`);
  const data = saved ? JSON.parse(saved) : {};
  Object.assign(data, changes);
  localStorage.setItem(`brandConfig_${suffix}`, JSON.stringify(data));
}

function saveTagsConfig() {
  if (!getBrandStorageSuffix()) return;
  updateActiveBrandConfig({
    brand:  document.getElementById('cfg-tags-brand').value,
    comp:   document.getElementById('cfg-tags-comp').value,
    sector: document.getElementById('cfg-tags-sector').value
  });
  saveConfigSection('cfg-save-1');
}

function saveKeywordsConfig() {
  if (!getBrandStorageSuffix()) return;
  updateActiveBrandConfig({ palabrasClave: document.getElementById('cfg-keywords').value });
  saveConfigSection('cfg-save-2');
}

function saveSpokespeopleConfig() {
  if (!getBrandStorageSuffix()) return;
  updateActiveBrandConfig({ voceros: document.getElementById('cfg-spokespeople').value });
  saveConfigSection('cfg-save-3');
}

function showBrandLogoPreview(dataUrl) {
  const img = document.getElementById('brand-logo-img');
  const headerPreview = document.getElementById('brand-header-preview');
  if (!img || !headerPreview) return;
  if (dataUrl) {
    img.src = dataUrl;
    img.classList.remove('hidden');
    headerPreview.classList.add('has-brand-logo');
  } else {
    img.removeAttribute('src');
    img.classList.add('hidden');
    headerPreview.classList.remove('has-brand-logo');
  }
}

function handleBrandLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const suffix = getBrandStorageSuffix();
  if (!suffix) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    localStorage.setItem(`brandLogo_${suffix}`, dataUrl);
    showBrandLogoPreview(dataUrl);
  };
  reader.readAsDataURL(file);
}

function loadBrandConfigScreen() {
  const suffix = getBrandStorageSuffix();
  if (!suffix) return;

  const savedTags = localStorage.getItem(`brandConfig_${suffix}`);
  const tags = savedTags ? JSON.parse(savedTags) : {};
  document.getElementById('cfg-tags-brand').value = tags.brand || '';
  document.getElementById('cfg-tags-comp').value = tags.comp || '';
  document.getElementById('cfg-tags-sector').value = tags.sector || '';
  document.getElementById('cfg-keywords').value = tags.palabrasClave || '';
  document.getElementById('cfg-spokespeople').value = tags.voceros || '';

  showBrandLogoPreview(localStorage.getItem(`brandLogo_${suffix}`));
}

document.getElementById('btn-upload-logo').addEventListener('click', () => {
  document.getElementById('brand-logo-input').click();
});
document.getElementById('brand-logo-input').addEventListener('change', handleBrandLogoUpload);

function showStatus(id, type, message) {
  const el = document.getElementById(id);
  el.className = `send-status ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
