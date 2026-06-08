const express = require('express');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/logo', express.static(__dirname));

// Lee el logo y lo convierte a base64 para incrustarlo en el email
function getLogoBase64() {
  const logoPath = path.join(__dirname, 'Logo Horizontal. Negativo.png');
  const exists = fs.existsSync(logoPath);
  console.log(`[logo] ${exists ? '✓ encontrado' : '✗ NO encontrado'}: ${logoPath}`);
  if (exists) {
    return fs.readFileSync(logoPath).toString('base64');
  }
  return null;
}

function sentimentColor(sentiment) {
  if (sentiment === 'positive') return '#1EF455';
  if (sentiment === 'negative') return '#FF0B2E';
  return '#F5A623';
}

function sentimentLabel(sentiment) {
  if (sentiment === 'positive') return 'Positiva';
  if (sentiment === 'negative') return 'Negativa';
  return 'Neutral';
}

function noteTypeLabel(noteType) {
  if (noteType === 'proactiva') return 'Proactiva';
  if (noteType === 'reactiva') return 'Reactiva';
  return 'Espontánea';
}

// ===== AGRUPACIÓN DE MENCIONES POR ETIQUETAS DE MARCA =====

function parseTagList(str) {
  return (str || '')
    .split(/[,;|]/)
    .map(t => t.trim())
    .filter(Boolean);
}

function matchesAnyTag(mentionTags, configuredTags) {
  if (!configuredTags.length) return false;
  return mentionTags.some(mt => configuredTags.some(ct => mt.toLowerCase() === ct.toLowerCase()));
}

// Agrupa las menciones en Marca / Competencia / Sector / Sin sección según
// las etiquetas configuradas. Devuelve null si no hay etiquetas configuradas
// (en cuyo caso el reporte se arma sin secciones, como antes).
function groupMentionsBySection(mentions, brandTags) {
  const brandList  = parseTagList(brandTags && brandTags.brand);
  const compList   = parseTagList(brandTags && brandTags.comp);
  const sectorList = parseTagList(brandTags && brandTags.sector);

  if (!brandList.length && !compList.length && !sectorList.length) return null;

  const sections = { brand: [], comp: [], sector: [], none: [] };
  mentions.forEach(m => {
    const mentionTags = parseTagList(m.tagsCustomer);
    if (matchesAnyTag(mentionTags, brandList))            sections.brand.push(m);
    else if (matchesAnyTag(mentionTags, compList))        sections.comp.push(m);
    else if (matchesAnyTag(mentionTags, sectorList))      sections.sector.push(m);
    else                                                   sections.none.push(m);
  });
  return sections;
}

function sectionHeaderRowHTML(label) {
  return `<tr><td style="background-color:#555555;padding:10px 40px;">
    <p style="margin:0;font-size:16px;font-weight:700;color:#FFFFFF;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:1px;">${label}</p>
  </td></tr>`;
}

function spacerRowHTML(height) {
  return `<tr><td style="height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</td></tr>`;
}

function cardsRowHTML(cardsHTML) {
  return `<tr><td style="padding:0 40px;">${cardsHTML}</td></tr>`;
}

function mentionCardHTML(m) {
  const color = sentimentColor(m.sentiment);
  const label = sentimentLabel(m.sentiment);
  const badgeBg = color;
  const noteTypeLbl = m.noteType ? noteTypeLabel(m.noteType) : null;
  const date = m.date ? `<p style="margin:0 0 6px 0;font-size:12px;color:#888888;font-family:'Inter',sans-serif;">${m.date}</p>` : '';
  const source = m.source ? `<p style="margin:0 0 4px 0;font-size:12px;font-weight:600;color:#FF0B2E;font-family:'Oswald',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">${m.source}</p>` : '';
  const desc = m.description ? `<p style="margin:8px 0 0 0;font-size:14px;color:#333333;font-family:'Inter',sans-serif;line-height:1.5;">${m.description}</p>` : '';
  const fmtNum = (n) => {
    const num = Number(n);
    if (n == null || n === '' || isNaN(num)) return null;
    return num.toLocaleString('es-AR');
  };
  const reachFmt = fmtNum(m.reach);
  const engFmt   = fmtNum(m.engagement);
  const stats = (reachFmt != null || engFmt != null) ? `
    <table cellpadding="0" cellspacing="0" style="margin:10px 0 4px 0;border-collapse:collapse;">
      <tr>
        ${reachFmt != null ? `<td style="padding-right:24px;vertical-align:top;font-family:'Inter',sans-serif;">
          <span style="display:block;font-size:10px;font-weight:700;color:#888888;text-transform:uppercase;letter-spacing:0.6px;line-height:1.4;">ALCANCE</span>
          <span style="display:block;font-size:13px;color:#333333;font-weight:600;line-height:1.4;">${reachFmt}</span>
        </td>` : ''}
        ${engFmt != null ? `<td style="vertical-align:top;font-family:'Inter',sans-serif;">
          <span style="display:block;font-size:10px;font-weight:700;color:#888888;text-transform:uppercase;letter-spacing:0.6px;line-height:1.4;">INTERACCIONES</span>
          <span style="display:block;font-size:13px;color:#333333;font-weight:600;line-height:1.4;">${engFmt}</span>
        </td>` : ''}
      </tr>
    </table>` : '';
  const link = m.link ? `<a href="${m.link}" style="display:inline-block;margin-top:10px;font-size:12px;color:#FF0B2E;font-family:'Inter',sans-serif;text-decoration:none;">Ver nota completa →</a>` : '';

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:0;border-collapse:collapse;border-bottom:1px solid #E0E0E0;">
      <tr>
        <td style="width:3px;background-color:${color};border-radius:2px 0 0 2px;">&nbsp;</td>
        <td style="background-color:#FAFAFA;padding:16px 20px;position:relative;border-radius:0 4px 4px 0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                ${source}
                ${date}
                <p style="margin:0 0 6px 0;font-size:16px;font-weight:600;color:#000000;font-family:'Oswald',sans-serif;line-height:1.3;">${m.title}</p>
                ${desc}
                ${stats}
                ${link}
              </td>
              <td style="width:100px;text-align:right;vertical-align:top;padding-left:12px;">
                <span style="display:inline-block;background-color:${badgeBg};color:#000000;font-size:11px;font-weight:700;font-family:'Inter',sans-serif;padding:3px 8px;border-radius:3px;white-space:nowrap;">${label}</span>
                ${noteTypeLbl ? `<br><span style="display:inline-block;margin-top:4px;background-color:#333333;color:#FFFFFF;font-size:10px;font-weight:700;font-family:'Inter',sans-serif;padding:3px 8px;border-radius:3px;white-space:nowrap;">${noteTypeLbl}</span>` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

// Arma las filas de la sección de menciones, agrupadas por etiquetas de marca
// si hay configuración disponible; si no, todas las menciones en una sola fila como antes.
function buildMentionsSectionHTML(sortedMentions, brandTags) {
  const grouped = groupMentionsBySection(sortedMentions, brandTags);

  if (!grouped) {
    return `<tr><td style="padding:24px 40px 32px 40px;">${sortedMentions.map(mentionCardHTML).join('')}</td></tr>`;
  }

  const rows = [spacerRowHTML(24)];
  let firstBlockRendered = false;

  [
    { items: grouped.brand,  label: 'MARCA' },
    { items: grouped.comp,   label: 'COMPETENCIA' },
    { items: grouped.sector, label: 'SECTOR' }
  ].forEach(({ items, label }) => {
    if (!items.length) return;
    if (firstBlockRendered) rows.push(spacerRowHTML(24));
    rows.push(sectionHeaderRowHTML(label));
    rows.push(cardsRowHTML(items.map(mentionCardHTML).join('')));
    firstBlockRendered = true;
  });

  if (grouped.none.length) {
    rows.push(cardsRowHTML(grouped.none.map(mentionCardHTML).join('')));
  }

  rows.push(spacerRowHTML(32));
  return rows.join('');
}

// Genera un Buffer PDF a partir de HTML usando Puppeteer/Chromium
async function buildPDF(html) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 980, height: 800 });
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
    });
    // Puppeteer v22+ devuelve Uint8Array — convertir a Buffer de Node para envío binario correcto
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// Convierte el título del reporte en un nombre de archivo seguro
function pdfFilename(title) {
  const safe = (title || 'Clipping')
    .replace(/·/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-áéíóúüñÁÉÍÓÚÜÑ]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `Clipping_${safe}.pdf`;
}

function buildEmailHTML(mentions, title, brandLogo, brandTags) {
  const logoBase64 = getLogoBase64();
  const logoSrc = logoBase64
    ? `data:image/png;base64,${logoBase64}`
    : '';

  const mileniumLogoHTML = logoSrc
    ? `<img src="${logoSrc}" alt="Milenium Group" style="height:42px;display:block;" />`
    : `<p style="color:#FFFFFF;font-family:'Oswald',sans-serif;font-size:22px;font-weight:600;margin:0;">MILENIUM GROUP</p>`;

  const headerHTML = brandLogo
    ? `<table width="100%" cellpadding="0" cellspacing="0"><tr>
         <td align="left" valign="middle">${mileniumLogoHTML}</td>
         <td align="right" valign="middle"><img src="${brandLogo}" alt="Logo de la marca" style="height:42px;width:auto;display:block;margin-left:auto;" /></td>
       </tr></table>`
    : `<div style="text-align:center;">${mileniumLogoHTML.replace('display:block;', 'display:block;margin:0 auto;')}</div>`;

  // Ordenar de mayor a menor engagement (nulls al final)
  const sorted = [...mentions].sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1));

  const mentionsSectionHTML = buildMentionsSectionHTML(sorted, brandTags);

  const reportTitle = title || 'Clipping de Medios';
  const dateStr = new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600&family=Noto+Serif:wght@400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<title>${reportTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#F0F0F0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F0F0F0;padding:32px 0;">
  <tr>
    <td align="center">
      <table width="900" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF;border-radius:6px;overflow:hidden;width:900px;max-width:900px;">

        <!-- HEADER -->
        <tr>
          <td style="background-color:#000000;padding:28px 40px;">
            ${headerHTML}
          </td>
        </tr>

        <!-- TÍTULO DEL REPORTE -->
        <tr>
          <td style="padding:28px 40px 20px 40px;border-bottom:2px solid #FF0B2E;">
            <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:#FF0B2E;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:1px;">Reporte de Medios</p>
            <h1 style="margin:0 0 6px 0;font-size:24px;font-weight:600;color:#000000;font-family:'Oswald',sans-serif;">${reportTitle}</h1>
            <p style="margin:0;font-size:13px;color:#888888;font-family:'Inter',sans-serif;">${dateStr}</p>
          </td>
        </tr>

        <!-- RESUMEN -->
        <tr>
          <td style="padding:20px 40px 8px 40px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td rowspan="3" align="center" valign="middle" style="padding:12px;background:#F9F9F9;border-radius:4px;vertical-align:middle;width:22%;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#000000;font-family:'Oswald',sans-serif;">${mentions.length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Menciones totales</p>
                </td>
                <td rowspan="3" width="12"></td>
                <td align="center" style="padding:12px;background:#F9F9F9;border-radius:4px;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#1EF455;font-family:'Oswald',sans-serif;">${mentions.filter(m => m.sentiment === 'positive').length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Positivas</p>
                </td>
                <td width="12"></td>
                <td align="center" style="padding:12px;background:#F9F9F9;border-radius:4px;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#F5A623;font-family:'Oswald',sans-serif;">${mentions.filter(m => m.sentiment === 'neutral').length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Neutrales</p>
                </td>
                <td width="12"></td>
                <td align="center" style="padding:12px;background:#F9F9F9;border-radius:4px;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#FF0B2E;font-family:'Oswald',sans-serif;">${mentions.filter(m => m.sentiment === 'negative').length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Negativas</p>
                </td>
              </tr>
              <tr>
                <td colspan="5" height="10"></td>
              </tr>
              <tr>
                <td align="center" style="padding:12px;background:#F9F9F9;border-radius:4px;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#000000;font-family:'Oswald',sans-serif;">${mentions.filter(m => !m.noteType || m.noteType === 'espontanea').length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Espontáneas</p>
                </td>
                <td width="12"></td>
                <td align="center" style="padding:12px;background:#F9F9F9;border-radius:4px;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#000000;font-family:'Oswald',sans-serif;">${mentions.filter(m => m.noteType === 'proactiva').length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Proactivas</p>
                </td>
                <td width="12"></td>
                <td align="center" style="padding:12px;background:#F9F9F9;border-radius:4px;">
                  <p style="margin:0 0 2px 0;font-size:22px;font-weight:700;color:#000000;font-family:'Oswald',sans-serif;">${mentions.filter(m => m.noteType === 'reactiva').length}</p>
                  <p style="margin:0;font-size:11px;color:#888888;font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Reactivas</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- MENCIONES -->
        ${mentionsSectionHTML}

        <!-- FOOTER -->
        <tr>
          <td style="background-color:#000000;padding:24px 40px;text-align:center;">
            ${logoSrc ? `<img src="${logoSrc}" alt="Milenium Group" style="height:28px;display:block;margin:0 auto 10px auto;opacity:0.85;" />` : ''}
            <p style="margin:0;font-size:12px;color:#FFFFFF;font-family:'Inter',sans-serif;opacity:0.7;">Milenium Group · Clipping de Medios</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// Endpoint: enviar clipping ahora
app.post('/api/send', async (req, res) => {
  const { mentions, recipients, title, subject, smtpConfig, brandLogo, brandTags } = req.body;

  if (!mentions || !recipients || !smtpConfig) {
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  const emailSubject = subject || `[Clipping de Medios] ${title || 'Clipping de Medios'}`;

  try {
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: parseInt(smtpConfig.port) || 587,
      secure: smtpConfig.port == 465,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      }
    });

    const html = buildEmailHTML(mentions, title, brandLogo, brandTags);

    // Generar PDF adjunto
    let attachments = [];
    try {
      const pdfBuffer = await buildPDF(html);
      attachments = [{ filename: pdfFilename(title), content: pdfBuffer, contentType: 'application/pdf' }];
      console.log(`[pdf] Adjunto generado: ${pdfFilename(title)}`);
    } catch (pdfErr) {
      console.error(`[pdf] Error generando adjunto (email se envía igual): ${pdfErr.message}`);
    }

    await transporter.sendMail({
      from: `"Milenium Group Clipping" <${smtpConfig.user}>`,
      to: recipients,
      subject: emailSubject,
      html,
      attachments
    });

    const adjMsg = attachments.length ? ' con PDF adjunto' : ' (sin PDF adjunto por error de generación)';
    res.json({ ok: true, message: `Email enviado correctamente${adjMsg}.` });
  } catch (err) {
    res.status(500).json({ error: `Error al enviar: ${err.message}` });
  }
});

// Endpoint: programar envío
app.post('/api/schedule', (req, res) => {
  const { mentions, recipients, title, subject, smtpConfig, scheduledAt, brandLogo, brandTags } = req.body;
  const emailSubject = subject || `[Clipping de Medios] ${title || 'Clipping de Medios'}`;

  if (!scheduledAt) {
    return res.status(400).json({ error: 'Falta la fecha de programación.' });
  }

  const sendDate = new Date(scheduledAt);
  if (isNaN(sendDate.getTime()) || sendDate <= new Date()) {
    return res.status(400).json({ error: 'La fecha debe ser futura.' });
  }

  schedule.scheduleJob(sendDate, async () => {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: parseInt(smtpConfig.port) || 587,
        secure: smtpConfig.port == 465,
        auth: { user: smtpConfig.user, pass: smtpConfig.pass }
      });
      const html = buildEmailHTML(mentions, title, brandLogo, brandTags);
      await transporter.sendMail({
        from: `"Milenium Group Clipping" <${smtpConfig.user}>`,
        to: recipients,
        subject: emailSubject,
        html
      });
      console.log(`Clipping enviado programado para ${sendDate.toISOString()}`);
    } catch (err) {
      console.error(`Error en envío programado: ${err.message}`);
    }
  });

  res.json({ ok: true, message: `Envío programado para ${sendDate.toLocaleString('es-AR')}` });
});

// Endpoint: previsualizar email HTML
app.post('/api/preview', (req, res) => {
  const { mentions, title, brandLogo, brandTags } = req.body;
  const html = buildEmailHTML(mentions || [], title, brandLogo, brandTags);
  res.send(html);
});

// Endpoint: descargar PDF
app.post('/api/pdf', async (req, res) => {
  const { mentions, title, brandLogo, brandTags } = req.body;
  try {
    const html = buildEmailHTML(mentions || [], title, brandLogo, brandTags);
    console.log('[pdf] Generando PDF...');
    const pdfBuffer = await buildPDF(html);
    const filename = pdfFilename(title);
    console.log(`[pdf] Listo: ${filename} (${pdfBuffer.length} bytes)`);
    // res.end() envía bytes binarios directamente sin pasar por el pipeline de Express
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error(`[pdf] Error: ${err.message}`);
    res.status(500).json({ error: `Error al generar PDF: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Clipping Milenium corriendo en http://localhost:${PORT}\n`);
});
