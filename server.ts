import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { getInvoice, previewInvoice, reserveInvoiceNumber, sha256, ValidationError } from "./invoices.js";
import { InvoiceMailer } from "./mailer.js";
import { NexlinkClient } from "./nexlink.js";
import { NotionInvoices } from "./notion.js";
import { renderInvoicePdf } from "./pdf.js";
import { syncNexlink } from "./sync.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const nexlink = new NexlinkClient(config);
const notion = new NotionInvoices(config);
const mailer = new InvoiceMailer(config);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const auth: RequestHandler = (req, res, next) => {
  const encoded = req.headers.authorization?.startsWith("Basic ") ? req.headers.authorization.slice(6) : "";
  const [username = "", password = ""] = Buffer.from(encoded, "base64").toString().split(":", 2);
  const safeEqual = (a: string, b: string) => {
    const aa = Buffer.from(a); const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  };
  if (!safeEqual(username, config.ADMIN_USERNAME) || !safeEqual(password, config.ADMIN_PASSWORD)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Facturación Telefonía"');
    res.status(401).send("Autenticación requerida");
    return;
  }
  next();
};

app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.use(auth);

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), process.env.NODE_ENV === "production" ? "../public" : "../public");
app.use(express.static(publicDir));

app.get("/api/dashboard", async (_req, res) => {
  const [customers, services, invoices, settings, sync] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM customers WHERE active=true"),
    pool.query("SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE rate_id IS NULL)::int AS missing_rates FROM services"),
    pool.query("SELECT status, COUNT(*)::int AS count FROM invoices GROUP BY status"),
    pool.query("SELECT * FROM app_settings WHERE id=1"),
    pool.query("SELECT MAX(synced_at) AS last_sync FROM services")
  ]);
  res.json({
    customers: customers.rows[0].count,
    services: services.rows[0].count,
    missingRates: services.rows[0].missing_rates,
    invoices: invoices.rows,
    settings: settings.rows[0],
    lastSync: sync.rows[0].last_sync,
    integrations: { nexlink: nexlink.configured(), notion: notion.configured(), gmail: mailer.configured() }
  });
});

app.get("/api/customers", async (_req, res) => {
  const result = await pool.query(
    `SELECT c.*, COUNT(s.id)::int AS services, COUNT(s.id) FILTER (WHERE s.rate_id IS NULL)::int AS missing_rates
     FROM customers c LEFT JOIN services s ON s.customer_id=c.id GROUP BY c.id ORDER BY c.name`
  );
  res.json(result.rows);
});

app.patch("/api/customers/:id", async (req, res) => {
  const body = z.object({ taxId: z.string().trim().min(1), billingAddress: z.string().trim().min(1), billingEmail: z.string().email(),
    vatRate: z.number().min(0).max(1).nullable(), paymentDays: z.number().int().min(0).nullable(), invoiceSeries: z.string().trim().min(1).nullable() }).parse(req.body);
  const result = await pool.query(
    `UPDATE customers SET tax_id=$2,billing_address=$3,billing_email=$4,vat_rate=$5,payment_days=$6,invoice_series=$7,updated_at=now()
     WHERE id=$1 RETURNING *`, [req.params.id, body.taxId, body.billingAddress, body.billingEmail, body.vatRate, body.paymentDays, body.invoiceSeries]
  );
  res.json(result.rows[0]);
});

app.get("/api/services", async (_req, res) => {
  const result = await pool.query(
    `SELECT s.id,s.line_identifier,s.status,s.operator,s.rate_id,s.discount_cents,c.name AS customer_name,
            p.name AS provider_product,r.name AS rate_name
     FROM services s JOIN customers c ON c.id=s.customer_id
     LEFT JOIN provider_products p ON p.nexlink_id=s.nexlink_product_id LEFT JOIN rates r ON r.id=s.rate_id
     ORDER BY c.name,s.line_identifier`
  );
  res.json(result.rows);
});

app.get("/api/rates", async (_req, res) => res.json((await pool.query("SELECT * FROM rates ORDER BY name")).rows));
app.post("/api/rates", async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1), serviceType: z.string().trim().min(1), monthlyFeeCents: z.number().int().min(0),
    includedGb: z.number().min(0).nullable(), includedMinutes: z.number().int().min(0).nullable(), excessGbCents: z.number().int().min(0).nullable(), fixedChargesCents: z.number().int().min(0).default(0) }).parse(req.body);
  const result = await pool.query(
    `INSERT INTO rates (name,service_type,monthly_fee_cents,included_gb,included_minutes,excess_gb_cents,fixed_charges_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [body.name, body.serviceType, body.monthlyFeeCents, body.includedGb, body.includedMinutes, body.excessGbCents, body.fixedChargesCents]
  );
  res.status(201).json(result.rows[0]);
});
app.patch("/api/services/:id/rate", async (req, res) => {
  const body = z.object({ rateId: z.string().uuid(), discountCents: z.number().int().min(0).default(0) }).parse(req.body);
  const result = await pool.query("UPDATE services SET rate_id=$2,discount_cents=$3 WHERE id=$1 RETURNING *", [req.params.id, body.rateId, body.discountCents]);
  res.json(result.rows[0]);
});
app.post("/api/services/:id/data-usage", async (req, res) => {
  const body = z.object({ periodStart: z.iso.date(), periodEnd: z.iso.date(), consumedGb: z.number().min(0) }).parse(req.body);
  if (body.periodStart > body.periodEnd) throw new ValidationError(["El inicio del periodo debe ser anterior al final."]);
  const result = await pool.query(
    `INSERT INTO data_usage (service_id,period_start,period_end,consumed_gb,verified_by)
     VALUES ($1,$2,$3,$4,'admin')
     ON CONFLICT (service_id,period_start,period_end) DO UPDATE SET consumed_gb=EXCLUDED.consumed_gb,
       verified_by='admin',verified_at=now() RETURNING *`,
    [req.params.id, body.periodStart, body.periodEnd, body.consumedGb]
  );
  res.json(result.rows[0]);
});

app.patch("/api/settings", async (req, res) => {
  const body = z.object({ invoiceSeries: z.string().trim().min(1), nextInvoiceNumber: z.number().int().positive(),
    defaultVatRate: z.number().min(0).max(1), defaultPaymentDays: z.number().int().min(0) }).parse(req.body);
  const result = await pool.query(
    `UPDATE app_settings SET invoice_series=$1,next_invoice_number=$2,default_vat_rate=$3,default_payment_days=$4,updated_at=now()
     WHERE id=1 RETURNING *`, [body.invoiceSeries, body.nextInvoiceNumber, body.defaultVatRate, body.defaultPaymentDays]
  );
  res.json(result.rows[0]);
});

app.post("/api/sync/nexlink", async (_req, res) => res.json(await syncNexlink(pool, nexlink)));
app.get("/api/invoices", async (_req, res) => {
  const result = await pool.query(`SELECT i.*,c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id ORDER BY i.created_at DESC LIMIT 100`);
  res.json(result.rows);
});
app.post("/api/invoices/preview", async (req, res) => {
  const body = z.object({ customerId: z.string().uuid(), periodStart: z.iso.date(), periodEnd: z.iso.date() }).parse(req.body);
  if (body.periodStart > body.periodEnd) throw new ValidationError(["El inicio del periodo debe ser anterior al final."]);
  res.status(201).json(await previewInvoice(pool, body));
});
app.get("/api/invoices/:id", async (req, res) => {
  const invoice = await getInvoice(pool, req.params.id);
  if (!invoice) return res.status(404).json({ error: "Factura no encontrada" });
  res.json(invoice);
});
app.get("/api/invoices/:id/pdf", async (req, res) => {
  const result = await pool.query("SELECT invoice_number,pdf_data FROM invoices WHERE id=$1", [req.params.id]);
  if (!result.rowCount || !result.rows[0].pdf_data) return res.status(404).json({ error: "PDF no disponible" });
  res.type("application/pdf").setHeader("Content-Disposition", `inline; filename=Factura-${result.rows[0].invoice_number}.pdf`);
  res.send(result.rows[0].pdf_data);
});
app.post("/api/invoices/:id/discard", async (req, res) => {
  const result = await pool.query(
    `UPDATE invoices SET status='Anulada',updated_at=now()
     WHERE id=$1 AND invoice_number IS NULL AND status IN ('Borrador','Lista para revisión') RETURNING *`, [req.params.id]
  );
  if (!result.rowCount) throw new ValidationError(["Solo se puede descartar una vista previa que aún no tenga número."]);
  await pool.query("INSERT INTO audit_log (invoice_id,action,actor) VALUES ($1,'PREVIEW_DISCARDED','admin')", [req.params.id]);
  res.json(result.rows[0]);
});

app.post("/api/invoices/:id/approve", async (req, res) => {
  const body = z.object({ confirmation: z.literal("EMITIR Y ENVIAR") }).parse(req.body);
  void body;
  await reserveInvoiceNumber(pool, req.params.id);
  const invoice = await getInvoice(pool, req.params.id);
  if (!invoice) throw new Error("Factura no encontrada");
  const pdf = await renderInvoicePdf(invoice);
  await pool.query("UPDATE invoices SET pdf_data=$2,pdf_sha256=$3,updated_at=now() WHERE id=$1", [invoice.id, pdf, sha256(pdf)]);
  let notionPageId = (invoice as any).notion_page_id as string | null;
  if (!notionPageId) {
    notionPageId = await notion.createInvoice(invoice, pdf);
    await pool.query("UPDATE invoices SET notion_page_id=$2 WHERE id=$1", [invoice.id, notionPageId]);
  }
  try {
    const messageId = await mailer.send(invoice, pdf);
    const sentAt = new Date();
    await pool.query(
      `UPDATE invoices SET status='Enviada',gmail_message_id=$2,sent_at=$3,updated_at=now() WHERE id=$1`,
      [invoice.id, messageId, sentAt]
    );
    await pool.query("INSERT INTO audit_log (invoice_id,action,actor,details) VALUES ($1,'SENT','admin',$2)", [invoice.id, { messageId }]);
    try {
      await notion.markSent(notionPageId, sentAt);
    } catch (notionError) {
      await pool.query("INSERT INTO audit_log (invoice_id,action,actor,details) VALUES ($1,'NOTION_STATUS_ERROR','system',$2)", [invoice.id, { message: (notionError as Error).message }]);
    }
  } catch (error) {
    await pool.query("UPDATE invoices SET status='Error de envío',updated_at=now() WHERE id=$1", [invoice.id]);
    await notion.markError(notionPageId).catch(() => undefined);
    await pool.query("INSERT INTO audit_log (invoice_id,action,actor,details) VALUES ($1,'SEND_ERROR','admin',$2)", [invoice.id, { message: (error as Error).message }]);
    throw error;
  }
  res.json(await getInvoice(pool, invoice.id));
});

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(error);
  if (error instanceof ValidationError) return res.status(422).json({ error: error.message, issues: error.issues });
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Datos inválidos", issues: error.issues });
  res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
};
app.use(errors);

await migrate(pool);
const server = app.listen(config.PORT, "0.0.0.0", () => console.log(`Facturación Telefonía en :${config.PORT}`));
process.on("SIGTERM", () => server.close(() => pool.end()));
