// Estado de la aplicación
let mentions = [];

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

// ===== PARSEO TALKWALKER CSV =====

// Botón "Parsear CSV" — lee desde el textarea
document.getElementById('btn-parse').addEventListener('click', () => {
  const raw = document.getElementById('tw-input').value;
  if (!raw.trim()) {
    alert('Pegá el contenido CSV de TalkWalker, o subí el archivo con el botón de arriba.');
    return;
  }
  runCSVParse(raw);
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

function readFileAsUTF8(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    // Mostrar el texto en el textarea también (útil para depuración)
    document.getElementById('tw-input').value = text;
    // Actualizar indicador visual del archivo
    const nameEl = document.getElementById('csv-file-name');
    nameEl.textContent = `✓ ${file.name}`;
    nameEl.classList.remove('hidden');
    uploadZone.classList.add('has-file');
    // Parsear automáticamente
    runCSVParse(text);
  };
  reader.onerror = () => {
    alert('Error al leer el archivo. Intentá pegar el contenido manualmente en el campo de texto.');
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
    const iUrl        = col('url');
    const iSentiment  = col('sentiment');
    const iReach      = col('reach');
    const iEngagement = col('engagement');

    // Validar que al menos title o url estén presentes
    if (iTitle === -1 && iUrl === -1) {
      throw new Error('No se encontraron las columnas esperadas. Verificá que el CSV tenga encabezados "title" y "url".');
    }

    const get = (row, idx) => (idx !== -1 && idx < row.length) ? row[idx].trim() : '';

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

        return {
          id: `m_${idx}_${Date.now()}`,
          title:       get(row, iTitle) || 'Sin título',
          source:      sourceVal,
          date,
          description: get(row, iSnippet),
          link:        get(row, iUrl),
          sentiment,
          reach:       (!isNaN(reach) && reach !== null)           ? reach      : null,
          engagement:  (!isNaN(engagement) && engagement !== null) ? engagement : null,
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

// ===== RENDERIZADO DE MENCIONES =====

function renderMentions() {
  const list = document.getElementById('mentions-list');
  const count = document.getElementById('mentions-count');

  count.textContent = `${mentions.length} mención${mentions.length !== 1 ? 'es' : ''} encontrada${mentions.length !== 1 ? 's' : ''}`;

  if (mentions.length === 0) {
    list.innerHTML = '<p style="color:#888;font-size:14px;text-align:center;padding:32px 0;">No hay menciones. Podés volver a parsear el CSV.</p>';
    return;
  }

  list.innerHTML = mentions.map(m => {
    const statsHtml = (m.reach != null || m.engagement != null) ? `
      <div class="mention-stats">
        ${m.reach != null ? `<span class="mention-stat"><span class="stat-label">Alcance</span> ${formatNumber(m.reach)}</span>` : ''}
        ${m.engagement != null ? `<span class="mention-stat"><span class="stat-label">Interacciones</span> ${formatNumber(m.engagement)}</span>` : ''}
      </div>` : '';

    return `
    <div class="mention-card" data-sentiment="${m.sentiment}" data-id="${m.id}">
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
        <button class="btn-delete" onclick="deleteMention('${m.id}')" title="Eliminar mención">✕</button>
      </div>
    </div>`;
  }).join('');
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

  const payload = { mentions, recipients, title, subject, smtpConfig };
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
      body: JSON.stringify({ mentions, title })
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
      body: JSON.stringify({ mentions, title })
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

function showStatus(id, type, message) {
  const el = document.getElementById(id);
  el.className = `send-status ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
