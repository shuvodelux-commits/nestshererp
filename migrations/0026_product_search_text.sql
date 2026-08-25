-- Phase 6 — one searchable line per product (§5.5, §5.7, owner request
-- 2026-08-26). Forward-only and additive (SRS 3.10).
--
-- A counter types fragments in any order — `aci salt`, `salt aci`, `sam a15`,
-- `মরিচ ২০০` — and every one of them has to be found somewhere in the product's
-- identity: its name, brand, category, code, barcode or unit. Matching that
-- with six `ILIKE`s per token, per row, per keystroke is work the database
-- should never be asked to repeat.
--
-- So the text is **computed once, when the product is written**, and stored
-- normalised: lower case, Bangla digits folded to Western (`১২w` finds `12W`),
-- Unicode composed, punctuation and spacing reduced to single spaces. The
-- normaliser is `core-domain/catalog/product-search.ts` and it is the same
-- function the counter uses to rank what comes back — one rule, two places it
-- runs, no chance of the two disagreeing about what matches.
--
-- `aliases` is what a shop calls something when the catalogue calls it
-- otherwise: `ফ্রিজ` for a refrigerator, `commode` for a toilet pan. Free text,
-- and searchable exactly like the name.
ALTER TABLE products ADD COLUMN aliases TEXT;
ALTER TABLE products ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

-- Backfilled from what each product already carries. The application writes it
-- from here on; this is the one time SQL has to know the shape of it, and it is
-- deliberately the *simple* half of the rule — the application's normaliser
-- then rewrites every row it touches, so a product edited after this migration
-- gets the full treatment (Bangla digits, Unicode composition) automatically.
UPDATE products p
   SET search_text = lower(regexp_replace(
         concat_ws(' ',
           p.name,
           (SELECT b.name FROM brands b WHERE b.id = p.brand_id),
           (SELECT c.name FROM categories c WHERE c.id = p.category_id),
           p.sku, p.barcode,
           (SELECT u.name FROM units u WHERE u.id = p.base_unit_id)
         ),
         '[^[:alnum:]ঀ-৿]+', ' ', 'g'))
 WHERE p.deleted_at IS NULL;

-- `pg_trgm` is already installed (0008) and this is exactly what it is for:
-- `LIKE '%fragment%'` over one column, which no B-tree can help with.
CREATE INDEX products_search_text_trgm_idx ON products USING GIN (search_text gin_trgm_ops);
