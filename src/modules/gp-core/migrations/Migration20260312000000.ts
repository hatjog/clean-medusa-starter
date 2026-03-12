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
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seller_city ON seller (city);
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seller_avg_rating ON seller (avg_rating);
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sspp_product_id ON seller_seller_product_product (product_id);
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

    // Seller filter fields
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_seller_city ON seller (city)`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_seller_avg_rating ON seller (avg_rating)`
    );

    // Junction table lookup indexes
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_sspp_product_id ON seller_seller_product_product (product_id)`
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_product_tags_tag_id ON product_tags (product_tag_id)`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS idx_variant_metadata_duration`
    );
    this.addSql(`DROP INDEX IF EXISTS idx_seller_city`);
    this.addSql(`DROP INDEX IF EXISTS idx_seller_avg_rating`);
    this.addSql(`DROP INDEX IF EXISTS idx_sspp_product_id`);
    this.addSql(`DROP INDEX IF EXISTS idx_product_tags_tag_id`);
  }
}
