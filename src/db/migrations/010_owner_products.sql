-- Products the owner adds on the admin page, next to the ones read from Shopify. The form fields are kept
-- here; the brief built from them is stored in `briefs` like a Shopify product's. Which products get videos
-- (kv products_active) and the uploaded logo (kv brand_logo) live in kv.
CREATE TABLE owner_products (
  handle TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
