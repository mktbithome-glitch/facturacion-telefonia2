import PDFDocument from "pdfkit";
import { eur } from "./money.js";

type Invoice = any;

const issuer = {
  name: "RED PRIMER CORP, S.L.",
  taxId: "B75552778",
  address: "Calle Sant Pere, núm. 54, 08221 Terrassa (Barcelona)",
  email: "info.redprime@gmail.com",
  phone: "+34 601 67 21 91"
};

export async function renderInvoicePdf(invoice: Invoice): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Factura ${invoice.invoice_number}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const navy = "#172033";
  const cyan = "#00A3A3";
  const muted = "#687386";
  doc.rect(0, 0, 595.28, 118).fill(navy);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(19).text(issuer.name, 48, 40);
  doc.font("Helvetica").fontSize(9).fillColor("#d8deea")
    .text(`${issuer.taxId} · ${issuer.email} · ${issuer.phone}`, 48, 70)
    .text(issuer.address, 48, 85);
  doc.font("Helvetica-Bold").fontSize(23).fillColor("#ffffff").text("FACTURA", 410, 39, { width: 137, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#d8deea").text(invoice.invoice_number, 410, 72, { width: 137, align: "right" });

  let y = 148;
  doc.fillColor(muted).font("Helvetica-Bold").fontSize(8).text("FACTURAR A", 48, y);
  doc.fillColor(navy).fontSize(12).text(invoice.customer_name, 48, y + 16);
  doc.font("Helvetica").fontSize(9).text(invoice.tax_id, 48, y + 35).text(invoice.billing_address, 48, y + 49, { width: 260 });

  doc.fillColor(muted).font("Helvetica-Bold").fontSize(8).text("EMISIÓN", 360, y);
  doc.fillColor(navy).font("Helvetica").fontSize(9).text(invoice.issued_at, 440, y, { width: 107, align: "right" });
  doc.fillColor(muted).font("Helvetica-Bold").fontSize(8).text("VENCIMIENTO", 360, y + 18);
  doc.fillColor(navy).font("Helvetica").fontSize(9).text(invoice.due_at, 440, y + 18, { width: 107, align: "right" });
  doc.fillColor(muted).font("Helvetica-Bold").fontSize(8).text("PERIODO", 360, y + 36);
  doc.fillColor(navy).font("Helvetica").fontSize(9).text(`${invoice.period_start} – ${invoice.period_end}`, 420, y + 36, { width: 127, align: "right" });

  y = 235;
  doc.rect(48, y, 499, 28).fill("#eef2f6");
  const cols = [48, 153, 248, 293, 343, 398, 477];
  const headers = ["Línea", "Tarifa", "Incl.", "Cons.", "Exceso", "Otros", "Importe"];
  doc.fillColor(navy).font("Helvetica-Bold").fontSize(8);
  headers.forEach((header, i) => doc.text(header, cols[i]!, y + 10, { width: i === 0 ? 98 : i === 1 ? 88 : i === 5 ? 72 : 45, align: i > 1 ? "right" : "left" }));
  y += 36;
  doc.font("Helvetica").fontSize(8.5);
  for (const line of invoice.lines) {
    if (y > 690) {
      doc.addPage();
      y = 55;
    }
    doc.fillColor(navy).text(line.line_identifier, cols[0]!, y, { width: 98 });
    doc.text(line.rate_name, cols[1]!, y, { width: 88 });
    doc.text(line.included_gb ?? "—", cols[2]!, y, { width: 40, align: "right" });
    doc.text(line.consumed_gb ?? "—", cols[3]!, y, { width: 44, align: "right" });
    doc.text(line.excess_gb ?? "0", cols[4]!, y, { width: 47, align: "right" });
    doc.text(eur.format(Number(line.other_charges_cents + line.usage_charges_cents) / 100), cols[5]!, y, { width: 70, align: "right" });
    doc.font("Helvetica-Bold").text(eur.format(Number(line.amount_cents) / 100), cols[6]!, y, { width: 70, align: "right" });
    doc.font("Helvetica").fontSize(7).fillColor(muted).text(`Descuento: ${eur.format(Number(line.discount_cents) / 100)}`, cols[1]!, y + 13, { width: 180 });
    doc.fontSize(8.5);
    doc.moveTo(48, y + 27).lineTo(547, y + 27).strokeColor("#e5e9ef").lineWidth(0.5).stroke();
    y += 37;
  }

  y = Math.max(y + 20, 490);
  const labelX = 340;
  const valueX = 455;
  doc.fillColor(muted).font("Helvetica").fontSize(9).text("Base imponible", labelX, y);
  doc.fillColor(navy).text(eur.format(invoice.subtotal_cents / 100), valueX, y, { width: 92, align: "right" });
  doc.fillColor(muted).text(`IVA ${new DecimalValue(invoice.vat_rate).mul(100)}%`, labelX, y + 22);
  doc.fillColor(navy).text(eur.format(invoice.vat_cents / 100), valueX, y + 22, { width: 92, align: "right" });
  doc.rect(labelX - 10, y + 47, 217, 48).fill(cyan);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text("TOTAL", labelX, y + 65);
  doc.fontSize(16).text(eur.format(invoice.total_cents / 100), valueX - 8, y + 61, { width: 100, align: "right" });

  doc.fillColor(muted).font("Helvetica").fontSize(8)
    .text("Documento generado tras validación de datos y aprobación expresa. Moneda: EUR.", 48, 754, { width: 499, align: "center" });
  doc.end();
  return done;
}

class DecimalValue {
  constructor(private readonly value: string | number) {}
  mul(factor: number) { return (Number(this.value) * factor).toLocaleString("es-ES", { maximumFractionDigits: 2 }); }
}
