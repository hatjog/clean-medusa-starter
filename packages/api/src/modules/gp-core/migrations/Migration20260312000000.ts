import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Indexes for storefront filter pipeline performance.
 *
 * DEV NOTE: Uses CREATE INDEX IF NOT EXISTS (without CONCURRENTLY) so it runs inside
 * a MikroORM transaction. For production deployments, run the CONCURRENTLY variants
 * manually in a separate DB session BEFORE deploying:
 *
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_variant_metadata_duration
 *     ON product_variant (((metadata->>'duration')::int))
 *     WHERE metadata->>'duration' IS NOT NULL AND metadata->>'duration' ~ '^\d+$';
 *   (idx_seller_avg_rating removed — column does not exist, see Migration20260312100000)
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ppss_product_id ON product_product_seller_seller (product_id);
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_tags_tag_id ON product_tags (product_tag_id);
 */
export class Migration20260312000000 extends Migration {
  async up(): Promise<void> {
    // Expression index on variant metadata duration (prevents sequential scan)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_variant_metadata_duration
        ON product_variant (((metadata->>'duration')::int))
        WHERE metadata->>'duration' IS NOT NULL
          AND metadata->>'duration' ~ '^\\d+$'
    `);
    // idx_seller_avg_rating removed — seller.avg_rating column does not exist.
    // Replaced by idx_ssrr_seller_id in Migration20260312100000.

    // Junction table lookup indexes
    this.addSql(`
      DO $$ BEGIN
        IF to_regclass('public.product_product_seller_seller') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_ppss_product_id
            ON product_product_seller_seller (product_id);
        END IF;
      END $$
    `);
    this.addSql(`
      DO $$ BEGIN
        IF to_regclass('public.product_tags') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_product_tags_tag_id
            ON product_tags (product_tag_id);
        END IF;
      END $$
    `);
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS idx_variant_metadata_duration`
    );
    // idx_seller_avg_rating removed — see Migration20260312100000
    this.addSql(`DROP INDEX IF EXISTS idx_ppss_product_id`);
    this.addSql(`DROP INDEX IF EXISTS idx_product_tags_tag_id`);
  }
}
