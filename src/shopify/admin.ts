import { z } from 'zod';
import { MAX_PHOTOS, MAX_PRODUCTS, Products, type Fetch, type RawProduct, type ShopMeta } from './fetch.ts';

const API_VERSION = '2026-10';

// Never put a response body or credentials in an error: the body may echo them.
async function post(url: string, init: RequestInit, f: Fetch, what: string): Promise<unknown> {
  const res = await f(url, { ...init, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return res.json();
}

const Token = z.object({ access_token: z.string().min(1) });
const Money = z.string().nullable();
const Data = z.object({
  data: z.object({
    shop: z.object({ name: z.string(), currencyCode: z.string(), primaryDomain: z.object({ host: z.string() }), shipsToCountries: z.array(z.string()) }),
    products: z.object({
      nodes: z.array(
        z.object({
          title: z.string(),
          handle: z.string(),
          descriptionHtml: z.string(),
          updatedAt: z.string(),
          vendor: z.string(),
          productType: z.string(),
          tags: z.array(z.string()),
          options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
          variants: z.object({ nodes: z.array(z.object({ title: z.string(), price: z.string(), compareAtPrice: Money, availableForSale: z.boolean() })) }),
          images: z.object({ nodes: z.array(z.object({ url: z.string(), width: z.number().nullable(), height: z.number().nullable() })) }),
        }),
      ),
    }),
  }),
});

const QUERY = `query {
  shop { name currencyCode primaryDomain { host } shipsToCountries }
  products(first: ${MAX_PRODUCTS}, query: "status:active") { nodes {
    title handle descriptionHtml updatedAt vendor productType tags options { name values }
    variants(first: 100) { nodes { title price compareAtPrice availableForSale } }
    images(first: ${MAX_PHOTOS}) { nodes { url width height } }
  } }
}`;

// Client-credentials grant: a token is fetched on every run and never stored.
export async function fetchShopAdmin(shop: string, clientId: string, clientSecret: string, f: Fetch): Promise<{ meta: ShopMeta; products: RawProduct[] }> {
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const tok = Token.parse(await post(`https://${shop}/admin/oauth/access_token`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }, f, 'admin token request'));
  const body = await post(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    { headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok.access_token }, body: JSON.stringify({ query: QUERY }) },
    f,
    'admin graphql request',
  );
  const r = Data.safeParse(body);
  if (!r.success) throw new Error('admin graphql: unexpected response (check the app has read_products)');
  const { shop: s, products } = r.data.data;
  return {
    meta: { name: s.name, currency: s.currencyCode, domain: s.primaryDomain.host, ships_to_countries: s.shipsToCountries },
    products: Products.parse({
      products: products.nodes.map((p) => ({
        title: p.title,
        handle: p.handle,
        body_html: p.descriptionHtml,
        updated_at: p.updatedAt,
        vendor: p.vendor,
        product_type: p.productType,
        tags: p.tags,
        options: p.options,
        variants: p.variants.nodes.map((v) => ({ title: v.title, price: v.price, compare_at_price: v.compareAtPrice, available: v.availableForSale })),
        images: p.images.nodes.flatMap((i) => (i.width && i.height ? [{ src: i.url, width: i.width, height: i.height }] : [])),
      })),
    }).products,
  };
}
