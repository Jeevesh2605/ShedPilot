/**
 * pdf_export: builds a real multi-page PDF sales report with pdfkit.
 *
 * This is the expensive feature in the demo. The cost is genuine CPU work: laying out text,
 * drawing vector charts and compressing every page. There is no sleep anywhere.
 * PDF_PAGES controls how much work each report does (tuned so one report takes 2 to 4 s on Lambda).
 */
// The standalone build embeds pdfkit's font metrics, so it still works after esbuild bundling.
import PDFDocument from 'pdfkit/js/pdfkit.standalone';
import { generateOrders, type Order } from '../data';

const ROWS_PER_PAGE = 32;

export async function buildPdfReport(pages: number): Promise<Buffer> {
  const orders = generateOrders(pages * ROWS_PER_PAGE);
  const doc = new PDFDocument({ size: 'A4', margin: 40, compress: true });

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  for (let page = 0; page < pages; page++) {
    if (page > 0) doc.addPage();
    const slice = orders.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
    drawHeader(doc, page + 1, pages);
    drawBarChart(doc, slice);
    drawTable(doc, slice);
  }

  doc.end();
  return finished;
}

function drawHeader(doc: PDFKit.PDFDocument, page: number, pages: number) {
  doc.fontSize(18).fillColor('#111').text('Quarterly sales report', 40, 40);
  doc.fontSize(9).fillColor('#666').text(`Page ${page} of ${pages}  ·  generated ${new Date().toISOString()}`);
}

/** One bar per order on this page, drawn as vector paths with grid lines and labels. */
function drawBarChart(doc: PDFKit.PDFDocument, rows: Order[]) {
  const left = 40, top = 90, width = 515, height = 150;
  const max = Math.max(...rows.map((r) => r.amount), 1);

  doc.lineWidth(0.3).strokeColor('#ccc');
  for (let i = 0; i <= 5; i++) {
    const y = top + (height * i) / 5;
    doc.moveTo(left, y).lineTo(left + width, y).stroke();
    doc.fontSize(6).fillColor('#999').text(String(Math.round(max * (1 - i / 5))), left - 30, y - 3, { width: 26, align: 'right' });
  }

  const barWidth = width / rows.length;
  rows.forEach((row, i) => {
    const barHeight = (row.amount / max) * height;
    doc.rect(left + i * barWidth + 1, top + height - barHeight, barWidth - 2, barHeight).fill(i % 2 ? '#4f7cac' : '#88a9cf');
  });
}

function drawTable(doc: PDFKit.PDFDocument, rows: Order[]) {
  const columns = [
    { title: 'Order', x: 40 }, { title: 'Day', x: 110 }, { title: 'Region', x: 160 },
    { title: 'Product', x: 250 }, { title: 'Qty', x: 360 }, { title: 'Amount (Rs)', x: 420 },
  ];
  let y = 260;
  doc.fontSize(8).fillColor('#111');
  for (const c of columns) doc.text(c.title, c.x, y);
  y += 14;
  for (const row of rows) {
    const values = [row.id, row.day, row.region, row.product, row.quantity, row.amount.toLocaleString('en-IN')];
    values.forEach((v, i) => doc.fillColor('#333').text(String(v), columns[i].x, y, { width: 90 }));
    y += 15;
  }
}
