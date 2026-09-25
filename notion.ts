import type { AppConfig } from "./config.js";
import { centsToEuros } from "./money.js";

export class NotionInvoices {
  constructor(private readonly config: AppConfig) {}

  configured() {
    return Boolean(this.config.NOTION_TOKEN && this.config.NOTION_INVOICES_DATA_SOURCE_ID);
  }

  private async request(path: string, init: RequestInit) {
    const response = await fetch(`https://api.notion.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.NOTION_TOKEN}`,
        "Notion-Version": "2025-09-03",
        ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`Notion respondió ${response.status}: ${(await response.text()).slice(0, 400)}`);
    return response.json() as Promise<any>;
  }

  private async uploadPdf(pdf: Buffer, filename: string) {
    const created = await this.request("/v1/file_uploads", {
      method: "POST",
      body: JSON.stringify({ mode: "single_part", filename, content_type: "application/pdf" })
    });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    await this.request(`/v1/file_uploads/${created.id}/send`, { method: "POST", body: form });
    return created.id as string;
  }

  async createInvoice(invoice: any, pdf: Buffer) {
    if (!this.configured()) throw new Error("Notion no está configurado");
    const filename = `Factura-${invoice.invoice_number}.pdf`;
    const uploadId = await this.uploadPdf(pdf, filename);
    const detailBlocks = invoice.lines.map((line: any) => ({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [{ type: "text", text: { content:
        `${line.line_identifier} · ${line.rate_name} · GB incluidos ${line.included_gb ?? "—"} · GB consumidos ${line.consumed_gb ?? "—"} · Exceso ${line.excess_gb ?? 0} GB · Otros ${centsToEuros(line.other_charges_cents)} € · Descuento ${centsToEuros(line.discount_cents)} € · Importe ${centsToEuros(line.amount_cents)} €`
      } }] }
    }));
    const body = {
      parent: { type: "data_source_id", data_source_id: this.config.NOTION_INVOICES_DATA_SOURCE_ID },
      properties: {
        "Factura": { title: [{ text: { content: `Factura ${invoice.invoice_number}` } }] },
        "Número de factura": { rich_text: [{ text: { content: invoice.invoice_number } }] },
        "Cliente": { rich_text: [{ text: { content: invoice.customer_name } }] },
        "NIF/CIF": { rich_text: [{ text: { content: invoice.tax_id } }] },
        "Dirección fiscal": { rich_text: [{ text: { content: invoice.billing_address } }] },
        "Email": { email: invoice.recipient_email },
        "Periodo inicial": { date: { start: invoice.period_start } },
        "Periodo final": { date: { start: invoice.period_end } },
        "Fecha de emisión": { date: { start: invoice.issued_at } },
        "Fecha de vencimiento": { date: { start: invoice.due_at } },
        "Subtotal": { number: invoice.subtotal_cents / 100 },
        "Tipo de IVA": { number: Number(invoice.vat_rate) },
        "Cuota de IVA": { number: invoice.vat_cents / 100 },
        "Total": { number: invoice.total_cents / 100 },
        "Estado": { select: { name: "Lista para revisión" } },
        "PDF": { files: [{ type: "file_upload", name: filename, file_upload: { id: uploadId } }] }
      },
      children: [{
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "Detalle por línea" } }] }
      }, ...detailBlocks]
    };
    const page = await this.request("/v1/pages", { method: "POST", body: JSON.stringify(body) });
    return page.id as string;
  }

  async markSent(pageId: string, sentAt: Date) {
    await this.request(`/v1/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: {
        "Estado": { select: { name: "Enviada" } },
        "Fecha de envío": { date: { start: sentAt.toISOString() } }
      } })
    });
  }

  async markError(pageId: string) {
    await this.request(`/v1/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { "Estado": { select: { name: "Error de envío" } } } })
    });
  }
}
