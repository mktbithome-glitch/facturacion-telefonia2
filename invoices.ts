import crypto from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { calculateLine, calculateVat } from "./money.js";

export class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(" "));
  }
}

export type InvoiceRecord = {
  id: string;
  invoice_number: string | null;
  status: string;
  period_start: string;
  period_end: string;
  subtotal_cents: number;
  vat_rate: string;
  vat_cents: number;
  total_cents: number;
  recipient_email: string;
  issued_at: string | null;
  due_at: string | null;
  customer_name: string;
  tax_id: string;
  billing_address: string;
};

export async function previewInvoice(pool: pg.Pool, input: { customerId: string; periodStart: string; periodEnd: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query("SELECT id, status FROM invoices WHERE customer_id=$1 AND period_start=$2 AND period_end=$3 AND status <> 'Anulada'", [input.customerId, input.periodStart, input.periodEnd]);
    if (duplicate.rowCount) throw new ValidationError([`El periodo ya tiene una factura (${duplicate.rows[0].status}).`]);
    const customerResult = await client.query(
      `SELECT c.*, s.default_vat_rate, s.default_payment_days, s.invoice_series AS default_series
       FROM customers c CROSS JOIN app_settings s WHERE c.id=$1`, [input.customerId]
    );
    if (!customerResult.rowCount) throw new ValidationError(["Cliente no encontrado."]);
    const customer = customerResult.rows[0];
    const issues: string[] = [];
    if (!customer.tax_id) issues.push("Falta NIF/CIF del cliente.");
    if (!customer.billing_address) issues.push("Falta dirección fiscal del cliente.");
    if (!customer.billing_email) issues.push("Falta email de facturación.");
    const vatRate = customer.vat_rate ?? customer.default_vat_rate;
    const paymentDays = customer.payment_days ?? customer.default_payment_days;
    const series = customer.default_series;
    if (vatRate == null) issues.push("Falta el tipo de IVA.");
    if (paymentDays == null) issues.push("Falta el plazo de pago.");
    if (!series) issues.push("Falta la serie de facturación.");

    const services = await client.query(
      `SELECT sv.id, sv.line_identifier, sv.current_consumption_raw, sv.rate_id, sv.discount_cents,
              r.name AS rate_name, r.monthly_fee_cents, r.included_gb, r.excess_gb_cents, r.fixed_charges_cents,
              du.consumed_gb,
              COALESCE(SUM(uc.amount_cents),0)::int AS provider_usage_cents
       FROM services sv
       LEFT JOIN rates r ON r.id=sv.rate_id AND r.active=true
       LEFT JOIN usage_calls uc ON uc.service_id=sv.id AND uc.used_at >= $2::date AND uc.used_at < ($3::date + interval '1 day')
       LEFT JOIN data_usage du ON du.service_id=sv.id AND du.period_start=$2::date AND du.period_end=$3::date
       WHERE sv.customer_id=$1
       GROUP BY sv.id, r.id, du.consumed_gb ORDER BY sv.line_identifier`, [input.customerId, input.periodStart, input.periodEnd]
    );
    if (!services.rowCount) issues.push("El cliente no tiene servicios activos sincronizados.");
    for (const service of services.rows) {
      if (!service.rate_id) issues.push(`La línea ${service.line_identifier} no tiene una tarifa propia asignada.`);
      if (service.included_gb != null && service.consumed_gb == null) issues.push(`Falta el consumo de GB verificado para la línea ${service.line_identifier} y este periodo.`);
    }
    if (issues.length) throw new ValidationError(issues);

    const lines = services.rows.map((service) => {
      const line = calculateLine({
        monthlyFeeCents: service.monthly_fee_cents,
        consumedGb: service.consumed_gb,
        includedGb: service.included_gb,
        excessGbCents: service.excess_gb_cents,
        // Nexlink's call amount is a provider-side reference, never a customer price.
        usageChargesCents: 0,
        otherChargesCents: service.fixed_charges_cents,
        discountCents: service.discount_cents
      });
      return { ...service, ...line, consumedGb: service.consumed_gb };
    });
    for (const line of lines) {
      if (line.amountCents < 0) throw new ValidationError([`El descuento de la línea ${line.line_identifier} supera sus cargos.`]);
    }
    const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
    const vat = calculateVat(subtotal, vatRate);
    const invoice = await client.query<{ id: string }>(
      `INSERT INTO invoices
        (customer_id, period_start, period_end, subtotal_cents, vat_rate, vat_cents, total_cents,
         recipient_email, status, validation_errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Lista para revisión','[]') RETURNING id`,
      [input.customerId, input.periodStart, input.periodEnd, subtotal, vatRate, vat, subtotal + vat, customer.billing_email]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO invoice_lines
          (invoice_id, service_id, line_identifier, rate_name, included_gb, consumed_gb, excess_gb,
           monthly_fee_cents, usage_charges_cents, other_charges_cents, discount_cents, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [invoice.rows[0]!.id, line.id, line.line_identifier, line.rate_name, line.included_gb,
          line.consumedGb, line.excessGb, line.monthly_fee_cents, 0,
          line.fixed_charges_cents, line.discount_cents, line.amountCents]
      );
    }
    await client.query("INSERT INTO audit_log (invoice_id, action, actor) VALUES ($1,'PREVIEW_CREATED','admin')", [invoice.rows[0]!.id]);
    await client.query("COMMIT");
    return getInvoice(pool, invoice.rows[0]!.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getInvoice(pool: pg.Pool, id: string) {
  const invoice = await pool.query<InvoiceRecord>(
    `SELECT i.*, c.name AS customer_name, c.tax_id, c.billing_address,
            COALESCE(i.invoice_number, s.invoice_series || '-' || lpad(s.next_invoice_number::text,5,'0')) AS display_invoice_number
     FROM invoices i JOIN customers c ON c.id=i.customer_id CROSS JOIN app_settings s WHERE i.id=$1`, [id]
  );
  if (!invoice.rowCount) return null;
  const lines = await pool.query("SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_identifier", [id]);
  return { ...invoice.rows[0], lines: lines.rows };
}

export async function reserveInvoiceNumber(pool: pg.Pool, id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoice = await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id]);
    if (!invoice.rowCount) throw new Error("Factura no encontrada");
    if (invoice.rows[0].status === "Enviada") throw new ValidationError(["La factura ya fue enviada y no puede reenviarse desde este flujo."]);
    if (invoice.rows[0].invoice_number) {
      await client.query("COMMIT");
      return invoice.rows[0].invoice_number as string;
    }
    if (invoice.rows[0].status !== "Lista para revisión") throw new ValidationError(["La factura no está lista para emitir."]);
    const settings = await client.query("SELECT * FROM app_settings WHERE id=1 FOR UPDATE");
    const { invoice_series: series, next_invoice_number: next } = settings.rows[0];
    if (!series || !next) throw new ValidationError(["Configura la serie y el número inicial antes de emitir."]);
    const number = `${series}-${String(next).padStart(5, "0")}`;
    const conflict = await client.query("SELECT id FROM invoices WHERE invoice_number=$1 AND id<>$2", [number, id]);
    if (conflict.rowCount) throw new ValidationError([`El número ${number} ya existe. Revisa la secuencia antes de continuar.`]);
    const issuedAt = new Date().toISOString().slice(0, 10);
    const customer = await client.query("SELECT COALESCE(payment_days, (SELECT default_payment_days FROM app_settings WHERE id=1)) AS days FROM customers WHERE id=$1", [invoice.rows[0].customer_id]);
    const days = Number(customer.rows[0].days);
    if (!Number.isFinite(days)) throw new ValidationError(["Falta el plazo de pago."]);
    await client.query(
      `UPDATE invoices SET invoice_number=$2, issued_at=$3::date, due_at=$3::date + $4::int,
       updated_at=now() WHERE id=$1`, [id, number, issuedAt, days]
    );
    await client.query("UPDATE app_settings SET next_invoice_number=next_invoice_number+1, updated_at=now() WHERE id=1");
    await client.query("INSERT INTO audit_log (invoice_id, action, actor, details) VALUES ($1,'NUMBER_RESERVED','admin',$2)", [id, { number }]);
    await client.query("COMMIT");
    return number;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function sha256(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
