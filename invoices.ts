import { Pool, PoolClient } from "pg";
import { eurosToCents, centsToEuros } from "./money";

type Json = Record<string, any>;

export interface InvoiceItem {
  description: string;
  amount_cents: number;
  vat_rate: number;
}

export interface CreateInvoiceInput {
  customer_id: string;
  issue_date: string;
  due_date: string;
  items: InvoiceItem[];
}

export async function generateInvoiceNumber(client: PoolClient): Promise<string> {
  const year = new Date().getFullYear();
  const res = await client.query<{ max_num: number }>(
    `SELECT MAX(CAST(SUBSTRING(number FROM 'FAC-${year}-([0-9]+)') AS INTEGER)) as max_num 
     FROM invoices 
     WHERE number LIKE $1`,
    [`FAC-${year}-%`]
  );

  const nextNum = (res.rows[0]?.max_num || 0) + 1;
  return `FAC-${year}-${String(nextNum).padStart(4, "0")}`;
}

export async function createInvoice(pool: Pool, input: CreateInvoiceInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invoiceNumber = await generateInvoiceNumber(client);

    const subtotalCents = input.items.reduce(
      (sum: number, item: InvoiceItem) => sum + item.amount_cents,
      0
    );

    // Asumimos un IVA por defecto (ej. 21%) basado en el primer ítem o 21 estándar
    const vatRate = input.items.length > 0 ? input.items[0].vat_rate : 21;
    const vatCents = Math.round(subtotalCents * (vatRate / 100));
    const totalCents = subtotalCents + vatCents;

    const invoiceRes = await client.query<{ id: string }>(
      `INSERT INTO invoices 
        (number, customer_id, issue_date, due_date, subtotal_cents, vat_cents, total_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
       RETURNING id`,
      [
        invoiceNumber,
        input.customer_id,
        input.issue_date,
        input.due_date,
        subtotalCents,
        vatCents,
        totalCents
      ]
    );

    const invoiceId = invoiceRes.rows[0].id;

    for (const item of input.items) {
      await client.query(
        `INSERT INTO invoice_items 
          (invoice_id, description, amount_cents, vat_rate)
         VALUES ($1, $2, $3, $4)`,
        [invoiceId, item.description, item.amount_cents, item.vat_rate]
      );
    }

    await client.query("COMMIT");
    return { id: invoiceId, number: invoiceNumber };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function calculateCustomerMonthlyServices(
  client: PoolClient,
  customerId: string
): Promise<InvoiceItem[]> {
  const servicesRes = await client.query(
    `SELECT s.*, p.recommended_price_base 
     FROM services s
     LEFT JOIN provider_products p ON s.nexlink_product_id = p.nexlink_id
     WHERE s.customer_id = $1 AND s.status = 'active'`,
    [customerId]
  );

  return servicesRes.rows.map((service: Json) => {
    const priceBase = service.recommended_price_base || 0;
    return {
      description: `Cuota mensual: ${service.line_identifier || service.service_type || "Servicio"}`,
      amount_cents: eurosToCents(priceBase),
      vat_rate: 21
    };
  });
}

export async function calculateCustomerMonthlyCalls(
  client: PoolClient,
  customerId: string
): Promise<InvoiceItem[]> {
  const callsRes = await client.query<{ total_amount: number }>(
    `SELECT COALESCE(SUM(c.amount_cents), 0) as total_amount
     FROM usage_calls c
     JOIN services s ON c.service_id = s.id
     WHERE s.customer_id = $1 AND c.invoiced = false`,
    [customerId]
  );

  const totalCallsCents = Number(callsRes.rows[0]?.total_amount || 0);

  if (totalCallsCents <= 0) return [];

  return [
    {
      description: "Consumo de llamadas fuera de bono",
      amount_cents: totalCallsCents,
      vat_rate: 21
    }
  ];
}

export async function generateDraftInvoiceForCustomer(
  pool: Pool,
  customerId: string,
  issueDate: string,
  dueDate: string
) {
  const client = await pool.connect();
  try {
    const serviceItems = await calculateCustomerMonthlyServices(client, customerId);
    const callItems = await calculateCustomerMonthlyCalls(client, customerId);

    const allItems = [...serviceItems, ...callItems];

    if (allItems.length === 0) {
      throw new Error("No hay cargos ni consumos pendientes para facturar a este cliente.");
    }

    const subtotalCents = allItems.reduce(
      (sum: number, line: InvoiceItem) => sum + line.amount_cents,
      0
    );

    return await createInvoice(pool, {
      customer_id: customerId,
      issue_date: issueDate,
      due_date: dueDate,
      items: allItems
    });
  } finally {
    client.release();
  }
}

export async function getInvoiceDetails(pool: Pool, invoiceId: string) {
  const client = await pool.connect();
  try {
    const invoiceRes = await client.query(
      `SELECT i.*, c.name as customer_name, c.tax_id, c.billing_address, c.billing_email 
       FROM invoices i
       JOIN customers c ON i.customer_id = c.id
       WHERE i.id = $1`,
      [invoiceId]
    );

    if (invoiceRes.rows.length === 0) {
      throw new Error("Factura no encontrada");
    }

    const itemsRes = await client.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1`,
      [invoiceId]
    );

    const invoice = invoiceRes.rows[0];
    return {
      ...invoice,
      subtotal_euros: centsToEuros(invoice.subtotal_cents),
      vat_euros: centsToEuros(invoice.vat_cents),
      total_euros: centsToEuros(invoice.total_cents),
      items: itemsRes.rows.map((item: Json) => ({
        ...item,
        amount_euros: centsToEuros(item.amount_cents)
      }))
    };
  } finally {
    client.release();
  }
}
