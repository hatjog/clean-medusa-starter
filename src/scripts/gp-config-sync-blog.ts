import { ExecArgs } from "@medusajs/framework/types"

// ---- Types ----

export type BlogPostFixture = {
  handle: string
  title: string
  content?: string
  status?: "published" | "draft"
  seo?: {
    meta_title?: string
    meta_description?: string
    [key: string]: unknown
  }
}

export type BlogSyncCounts = {
  created: number
  updated: number
  skipped: number
}

// ---- Core sync logic ----

export async function syncBlog(
  articleService: any,
  posts: BlogPostFixture[],
  marketId: string,
  dryRun: boolean,
  warnings: string[]
): Promise<BlogSyncCounts> {
  const counts: BlogSyncCounts = { created: 0, updated: 0, skipped: 0 }

  for (const post of posts) {
    if (!post.handle) {
      warnings.push(`Blog post '${post.title}': missing handle, skipping`)
      counts.skipped++
      continue
    }

    try {
      const existing = await articleService.list({ handle: post.handle })
      const existingPost = existing?.[0] ?? null

      const upsertPayload = {
        handle: post.handle,
        title: post.title,
        content: post.content,
        status: post.status ?? "draft",
        metadata: {
          gp: {
            synced_by: "gp-config-sync-blog",
            market_id: marketId,
            ...(post.seo ? { seo: post.seo } : {}),
          },
        },
        ...(existingPost ? { id: existingPost.id } : {}),
      }

      if (dryRun) {
        console.log(`[dry-run] Would upsert blog post handle='${post.handle}'`)
        counts.updated++
        continue
      }

      await articleService.upsert(upsertPayload)

      if (existingPost) {
        counts.updated++
      } else {
        counts.created++
      }
    } catch (e: any) {
      warnings.push(`Blog post '${post.handle}': ${e?.message ?? String(e)}`)
      counts.skipped++
    }
  }

  return counts
}

// ---- Default export: Medusa script entrypoint ----

export default async function gpConfigSyncBlog({ container: _container, args: _args }: ExecArgs) {
  // Blog sync via YAML config not yet wired to market fixtures.
  // syncBlog() is exported for integration into the orchestrator when blog YAML is ready.
  console.warn("[WARN][gp-config-sync-blog] Blog sync not yet wired to market YAML; no-op. Blog posts were NOT synced.")
}
