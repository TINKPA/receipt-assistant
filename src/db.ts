/**
 * PostgreSQL database layer for Receipt Assistant.
 *
 * Config via DATABASE_URL env var (Twelve-Factor principle III).
 * Uses pg.Pool for connection pooling.
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/receipts";

// ── Types ──────────────────────────────────────────────────────────

export interface ExtractionMeta {
  quality: {
    confidence_score: number;
    missing_fields: string[];
    warnings: string[];
  };
  business: {
    is_reimbursable: boolean;
    is_tax_deductible: boolean;
    is_recurring: boolean;
    is_split_bill: boolean;
  };
}

export interface ReceiptData {
  id: string;
  merchant: string;
  date: string;
  total: number;
  currency?: string;
  category?: string;
  payment_method?: string;
  tax?: number;
  tip?: number;
  notes?: string;
  raw_text?: string;
  image_path?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  place_id?: string;
  extraction_meta?: ExtractionMeta;
  items?: {
    name: string;
    quantity?: number;
    unit_price?: number;
    total_price?: number;
    category?: string;
  }[];
}

// ── Pool (singleton) ───────────────────────────────────────────────

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

// ── Schema initialization ──────────────────────────────────────────

let schemaInitialized = false;

export async function initSchema(): Promise<void> {
  if (schemaInitialized) return;
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      merchant TEXT NOT NULL,
      date TEXT NOT NULL,
      total REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      category TEXT,
      payment_method TEXT,
      tax REAL,
      tip REAL,
      notes TEXT,
      raw_text TEXT,
      image_path TEXT,
      extraction_meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS receipt_items (
      id SERIAL PRIMARY KEY,
      receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      quantity REAL DEFAULT 1,
      unit_price REAL,
      total_price REAL,
      category TEXT
    )
  `);

  // Add status column for async processing (placeholder → done/error)
  await p.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'done'`);

  // Geocoding columns (populated by post-extraction geocode step)
  await p.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS address TEXT`);
  await p.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS latitude REAL`);
  await p.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS longitude REAL`);
  await p.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS place_id TEXT`);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_receipts_merchant ON receipts(merchant)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_receipts_category ON receipts(category)`);

  schemaInitialized = true;
}

// ── CRUD functions ─────────────────────────────────────────────────

export async function insertReceipt(data: ReceiptData): Promise<ReceiptData> {
  const p = getPool();
  await initSchema();

  const client = await p.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO receipts (id, merchant, date, total, currency, category, payment_method, tax, tip, notes, raw_text, image_path, extraction_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        data.id,
        data.merchant,
        data.date,
        data.total,
        data.currency ?? "USD",
        data.category ?? null,
        data.payment_method ?? null,
        data.tax ?? null,
        data.tip ?? null,
        data.notes ?? null,
        data.raw_text ?? null,
        data.image_path ?? null,
        data.extraction_meta ? JSON.stringify(data.extraction_meta) : null,
      ]
    );

    if (data.items?.length) {
      for (const item of data.items) {
        await client.query(
          `INSERT INTO receipt_items (receipt_id, name, quantity, unit_price, total_price, category)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            data.id,
            item.name,
            item.quantity ?? 1,
            item.unit_price ?? null,
            item.total_price ?? null,
            item.category ?? null,
          ]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return data;
}

/**
 * Insert a placeholder receipt row with status='processing'.
 * Called immediately on upload so the receipt appears in GET /receipts
 * before extraction completes.
 */
export async function insertReceiptPlaceholder(
  id: string,
  imagePath: string,
  notes?: string
): Promise<void> {
  const p = getPool();
  await initSchema();
  await p.query(
    `INSERT INTO receipts (id, merchant, date, total, image_path, notes, status)
     VALUES ($1, 'Processing...', $2, 0, $3, $4, 'processing')`,
    [id, new Date().toISOString().slice(0, 10), imagePath, notes ?? null]
  );
}

/**
 * Update the status of a receipt (e.g. to 'error' on failure).
 */
export async function updateReceiptStatus(
  id: string,
  status: string,
  error?: string
): Promise<void> {
  const p = getPool();
  await initSchema();
  await p.query(
    `UPDATE receipts SET status = $1, notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3`,
    [status, error ?? null, id]
  );
}

/**
 * Update geocoding fields for a receipt. Called after the extraction
 * pipeline finishes. Fails silently if the receipt is gone.
 */
export async function updateReceiptGeocode(
  id: string,
  geo: { address?: string | null; latitude: number; longitude: number; place_id: string }
): Promise<void> {
  const p = getPool();
  await initSchema();
  await p.query(
    `UPDATE receipts
     SET address = COALESCE($1, address),
         latitude = $2,
         longitude = $3,
         place_id = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [geo.address ?? null, geo.latitude, geo.longitude, geo.place_id, id]
  );
}

export async function deleteReceipt(id: string): Promise<boolean> {
  const p = getPool();
  await initSchema();
  // CASCADE deletes receipt_items automatically
  const result = await p.query("DELETE FROM receipts WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getReceipt(id: string): Promise<(ReceiptData & { items: any[] }) | null> {
  const p = getPool();
  await initSchema();

  const receiptResult = await p.query("SELECT * FROM receipts WHERE id = $1", [id]);
  if (receiptResult.rows.length === 0) return null;

  const receipt = receiptResult.rows[0];
  const itemsResult = await p.query("SELECT * FROM receipt_items WHERE receipt_id = $1", [id]);

  return { ...receipt, items: itemsResult.rows };
}

export async function listReceipts(opts?: {
  from?: string;
  to?: string;
  category?: string;
  limit?: number;
}): Promise<any[]> {
  const p = getPool();
  await initSchema();

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (opts?.from) {
    conditions.push(`date >= $${paramIdx++}`);
    params.push(opts.from);
  }
  if (opts?.to) {
    conditions.push(`date <= $${paramIdx++}`);
    params.push(opts.to);
  }
  if (opts?.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(opts.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;

  const result = await p.query(
    `SELECT * FROM receipts ${where} ORDER BY date DESC LIMIT ${limit}`,
    params
  );
  return result.rows;
}

export async function getSpendingSummary(from?: string, to?: string): Promise<any[]> {
  const p = getPool();
  await initSchema();

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (from) {
    conditions.push(`date >= $${paramIdx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`date <= $${paramIdx++}`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await p.query(
    `SELECT
      category,
      COUNT(*)::int as count,
      ROUND(SUM(total)::numeric, 2) as total_spent,
      ROUND(AVG(total)::numeric, 2) as avg_per_receipt
    FROM receipts
    ${where}
    GROUP BY category
    ORDER BY total_spent DESC`,
    params
  );
  return result.rows;
}
