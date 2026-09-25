CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  invoice_series text,
  next_invoice_number integer CHECK (next_invoice_number > 0),
  default_vat_rate numeric(7,4) CHECK (default_vat_rate >= 0),
  default_payment_days integer CHECK (default_payment_days >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nexlink_id bigint UNIQUE,
  name text NOT NULL,
  tax_id text,
  billing_address text,
  billing_email text,
  phone text,
  customer_type text CHECK (customer_type IN ('Particular', 'Empresa')),
  vat_rate numeric(7,4) CHECK (vat_rate >= 0),
  payment_days integer CHECK (payment_days >= 0),
  invoice_series text,
  active boolean NOT NULL DEFAULT true,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_products (
  nexlink_id bigint PRIMARY KEY,
  name text NOT NULL,
  service_type text,
  provider_price_base numeric(12,4),
  recommended_price_base numeric(12,4),
  included_gb numeric(12,3),
  included_minutes integer,
  raw_data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  nexlink_product_id bigint REFERENCES provider_products(nexlink_id),
  service_type text NOT NULL,
  monthly_fee_cents integer NOT NULL CHECK (monthly_fee_cents >= 0),
  included_gb numeric(12,3),
  included_minutes integer,
  excess_gb_cents integer CHECK (excess_gb_cents >= 0),
  fixed_charges_cents integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nexlink_id bigint UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  external_id text,
  line_identifier text,
  status integer,
  service_type integer,
  operator text,
  nexlink_product_id bigint,
  rate_id uuid REFERENCES rates(id),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  current_consumption_raw numeric(18,3),
  total_available_consumption_raw numeric(18,3),
  raw_data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_calls (
  nexlink_id bigint PRIMARY KEY,
  service_id uuid REFERENCES services(id),
  customer_nexlink_id bigint,
  customer_number text,
  used_at timestamptz NOT NULL,
  duration_seconds integer,
  amount_cents integer NOT NULL DEFAULT 0,
  raw_data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  consumed_gb numeric(12,3) NOT NULL CHECK (consumed_gb >= 0),
  source text NOT NULL DEFAULT 'manual_verified',
  verified_by text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  invoice_number text UNIQUE,
  issued_at date,
  due_at date,
  subtotal_cents integer NOT NULL,
  vat_rate numeric(7,4) NOT NULL,
  vat_cents integer NOT NULL,
  total_cents integer NOT NULL,
  recipient_email text NOT NULL,
  status text NOT NULL CHECK (status IN ('Borrador', 'Lista para revisión', 'Enviada', 'Error de envío', 'Anulada')),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  pdf_data bytea,
  pdf_sha256 text,
  notion_page_id text,
  gmail_message_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id),
  line_identifier text NOT NULL,
  rate_name text NOT NULL,
  included_gb numeric(12,3),
  consumed_gb numeric(12,3),
  excess_gb numeric(12,3),
  monthly_fee_cents integer NOT NULL,
  usage_charges_cents integer NOT NULL DEFAULT 0,
  other_charges_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  amount_cents integer NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  invoice_id uuid REFERENCES invoices(id),
  action text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS services_customer_idx ON services(customer_id);
CREATE INDEX IF NOT EXISTS usage_calls_used_at_idx ON usage_calls(used_at);
CREATE INDEX IF NOT EXISTS data_usage_period_idx ON data_usage(period_start, period_end);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_active_period_unique
  ON invoices(customer_id, period_start, period_end) WHERE status <> 'Anulada';
