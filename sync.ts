import type pg from "pg";
import { eurosToCents } from "./money.js";
import type { NexlinkClient } from "./nexlink.js";

type Json = Record<string, any>;

function customerName(customer: Json) {
  return customer.company || [customer.name, customer.surname, customer.surname2].filter(Boolean).join(" ") || `Cliente Nexlink ${customer.id}`;
}

function customerAddress(customer: Json) {
  if (customer.address) return String(customer.address);
  const a = customer.address_object || {};
  const street = [a.streetType, a.streetName, a.streetNumber].filter(Boolean).join(" ");
  const extra = [a.planta && `Planta ${a.planta}`, a.puerta && `Puerta ${a.puerta}`, a.bloque && `Bloque ${a.bloque}`].filter(Boolean).join(", ");
  const city = [a.postCode || a.postalCode, a.city, a.province].filter(Boolean).join(" ");
  return [street, extra, city].filter(Boolean).join(", ");
}

function productInfo(product: Json) {
  const data = product.data || {};
  return {
    id: Number(product.id),
    name: String(product.name || `Producto ${product.id}`),
    type: data.hasMobile ? "Móvil" : data.hasInternet ? "Fibra" : data.hasLandLine ? "Fijo" : "Otro",
    includedGb: data.data == null ? null : Number(data.data) / 1000,
    includedMinutes: data.minutes == null ? null : Number(data.minutes)
  };
}

export async function syncNexlink(pool: pg.Pool, nexlink: NexlinkClient) {
  if (!nexlink.configured()) throw new Error("Configura Nexlink antes de sincronizar");
  const client = await pool.connect();
  try {
    const [products, services] = await Promise.all([
      nexlink.listProducts(),
      nexlink.listAll("/services/list")
    ]);
    await client.query("BEGIN");
    for (const raw of products) {
      const p = productInfo(raw);
      if (!Number.isFinite(p.id)) continue;
      await client.query(
        `INSERT INTO provider_products
          (nexlink_id, name, service_type, provider_price_base, recommended_price_base, included_gb, included_minutes, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (nexlink_id) DO UPDATE SET name=EXCLUDED.name, service_type=EXCLUDED.service_type,
          provider_price_base=EXCLUDED.provider_price_base, recommended_price_base=EXCLUDED.recommended_price_base,
          included_gb=EXCLUDED.included_gb, included_minutes=EXCLUDED.included_minutes,
          raw_data=EXCLUDED.raw_data, synced_at=now()`,
        [p.id, p.name, p.type, raw.priceBase ?? null, raw.recommendedPriceBase ?? null, p.includedGb, p.includedMinutes, raw]
      );
    }
    for (const raw of services) {
      const customer = raw.customer || {};
      const customerId = Number(raw.customerId ?? customer.id);
      if (!Number.isFinite(customerId) || !Number.isFinite(Number(raw.id))) continue;
      const savedCustomer = await client.query<{ id: string }>(
        `INSERT INTO customers (nexlink_id, name, tax_id, billing_address, billing_email, phone, customer_type, raw_data, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (nexlink_id) DO UPDATE SET name=EXCLUDED.name,
          tax_id=COALESCE(NULLIF(customers.tax_id,''),EXCLUDED.tax_id),
          billing_address=COALESCE(NULLIF(customers.billing_address,''),EXCLUDED.billing_address),
          billing_email=COALESCE(NULLIF(customers.billing_email,''),EXCLUDED.billing_email), phone=EXCLUDED.phone,
          customer_type=EXCLUDED.customer_type, raw_data=EXCLUDED.raw_data, updated_at=now()
         RETURNING id`,
        [customerId, customerName(customer), customer.cif || customer.identityCard || null, customerAddress(customer) || null,
          customer.email || null, customer.phone || null, Number(customer.type) === 3 ? "Empresa" : "Particular", customer]
      );
      const info = raw.info || {};
      const product = info.gelpiuProduct || {};
      const line = raw.externalId || raw.customerNumber || info.phone || `Servicio ${raw.id}`;
      await client.query(
        `INSERT INTO services
          (nexlink_id, customer_id, external_id, line_identifier, status, service_type, operator,
           nexlink_product_id, current_consumption_raw, total_available_consumption_raw, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (nexlink_id) DO UPDATE SET customer_id=EXCLUDED.customer_id, external_id=EXCLUDED.external_id,
          line_identifier=EXCLUDED.line_identifier, status=EXCLUDED.status, service_type=EXCLUDED.service_type,
          operator=EXCLUDED.operator, nexlink_product_id=EXCLUDED.nexlink_product_id,
          current_consumption_raw=EXCLUDED.current_consumption_raw,
          total_available_consumption_raw=EXCLUDED.total_available_consumption_raw,
          raw_data=EXCLUDED.raw_data, synced_at=now()`,
        [Number(raw.id), savedCustomer.rows[0]!.id, raw.externalId || null, line, raw.status ?? null, raw.type ?? null,
          raw.operator || null, product.id ?? null, info.currentConsumption ?? null,
          info.totalAvailableConsumption ?? null, raw]
      );
    }
    await client.query("COMMIT");

    const calls = await nexlink.listAll("/cdrs/calls");
    await client.query("BEGIN");
    for (const raw of calls) {
      const id = Number(raw.id);
      const timestamp = Number(raw.usageTimestamp);
      if (!Number.isFinite(id) || !Number.isFinite(timestamp)) continue;
      const service = await client.query<{ id: string }>("SELECT id FROM services WHERE nexlink_id=$1", [raw.serviceId]);
      await client.query(
        `INSERT INTO usage_calls
          (nexlink_id, service_id, customer_nexlink_id, customer_number, used_at, duration_seconds, amount_cents, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,now())
         ON CONFLICT (nexlink_id) DO UPDATE SET service_id=EXCLUDED.service_id, customer_nexlink_id=EXCLUDED.customer_nexlink_id,
          customer_number=EXCLUDED.customer_number, used_at=EXCLUDED.used_at, duration_seconds=EXCLUDED.duration_seconds,
          amount_cents=EXCLUDED.amount_cents, raw_data=EXCLUDED.raw_data, synced_at=now()`,
        [id, service.rows[0]?.id ?? null, raw.customerId ?? null, raw.customerNumber ?? null,
          timestamp, raw.durationSeconds ?? null, eurosToCents(raw.amount ?? 0), raw]
      );
    }
    await client.query("COMMIT");
    return { products: products.length, services: services.length, calls: calls.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
