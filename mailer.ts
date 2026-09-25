import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";
import { eur } from "./money.js";

export class InvoiceMailer {
  constructor(private readonly config: AppConfig) {}

  configured() { return Boolean(this.config.GMAIL_APP_PASSWORD); }

  async send(invoice: any, pdf: Buffer) {
    if (!this.config.GMAIL_APP_PASSWORD) throw new Error("Gmail no está configurado");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: this.config.GMAIL_USER, pass: this.config.GMAIL_APP_PASSWORD }
    });
    const result = await transporter.sendMail({
      from: `RED PRIMER CORP, S.L. <${this.config.GMAIL_USER}>`,
      to: invoice.recipient_email,
      subject: `Factura ${invoice.invoice_number} — RED PRIMER CORP, S.L.`,
      text: `Buenos días,\n\nAdjuntamos la factura ${invoice.invoice_number}, correspondiente al periodo ${invoice.period_start} a ${invoice.period_end}, por un total de ${eur.format(invoice.total_cents / 100)}. El vencimiento es el ${invoice.due_at}.\n\nLa factura se incluye en formato PDF.\n\nAtentamente,\nRED PRIMER CORP, S.L.`,
      attachments: [{ filename: `Factura-${invoice.invoice_number}.pdf`, content: pdf, contentType: "application/pdf" }]
    });
    return result.messageId;
  }
}
