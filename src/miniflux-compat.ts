import { Hono } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'
import { cors } from 'hono/cors'

// Local env type — avoids circular import with index.ts
interface CompatEnv {
  DB: D1Database
  SESSIONS: KVNamespace
  TSRSS_PASSWORD?: string
  TSRSS_AUTH_MODE?: string
}

export const miniflux = new Hono<{ Bindings: CompatEnv }>()

// ── CORS for browser-based clients (ReactFlux etc) ───────────────────────────
miniflux.use('/v1/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Auth-Token', 'Authorization'],
}))

// ── Auth helper ──────────────────────────────────────────────────────────────

function verifyAuth(c: any): boolean {
  const password = c.env.TSRSS_PASSWORD as string | undefined
  if (!password) return true

  // X-Auth-Token header
  const token = c.req.header('X-Auth-Token')
  if (token === password) return true

  // Authorization: Basic header
  const auth = c.req.header('Authorization') || ''
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6))
      const pass = decoded.slice(decoded.indexOf(':') + 1)
      if (pass === password) return true
    } catch {}
  }

  return false
}

function unauth(c: any) {
  return c.json({ error_message: 'Access Unauthorized', error_type: 'unauthorized' }, 401)
}

// ── GET /v1/version ──────────────────────────────────────────────────────────

miniflux.get('/v1/version', (c) => {
  return c.json({
    version: '2.2.0',
    commit: 'tsrss-compat',
    build_date: '2026-01-01T00:00:00Z',
  })
})

// ── GET /v1/me ───────────────────────────────────────────────────────────────

miniflux.get('/v1/me', (c) => {
  if (!verifyAuth(c)) return unauth(c)
  return c.json({
    id: 1,
    username: 'admin',
    is_admin: true,
    theme: 'dark_serif',
    language: 'en_US',
    timezone: 'UTC',
    entry_sorting_direction: 'desc',
    entry_sorting_order: 'published_at',
    entries_per_page: 100,
    keyboard_shortcuts: true,
    show_reading_time: true,
    entry_swipe: true,
    gesture_nav: 'tap',
    last_login_at: new Date().toISOString(),
    display_mode: 'standalone',
    default_reading_speed: 265,
    cjk_reading_speed: 500,
    default_home_page: 'unread',
    categories_sorting_order: 'unread_count',
    mark_read_on_view: true,
    mark_read_on_media_player_completion: false,
    media_playback_rate: 1,
    stylesheet: '',
    custom_js: '',
    external_font_hosts: '',
    google_id: '',
    openid_connect_id: '',
    block_filter_entry_rules: '',
    keep_filter_entry_rules: '',
    always_open_external_links: false,
    open_external_links_in_new_tab: true,
  })
})

// ── GET /v1/categories ───────────────────────────────────────────────────────

miniflux.get('/v1/categories', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const rows = await c.env.DB.prepare(
    "SELECT id, title FROM categories WHERE user_id = 'anonymous' ORDER BY sort_order ASC"
  ).all<{ id: number; title: string }>()
  return c.json(
    (rows.results || []).map(r => ({ id: r.id, title: r.title, user_id: 1, hide_globally: false }))
  )
})

// ── GET /v1/feeds ────────────────────────────────────────────────────────────

miniflux.get('/v1/feeds', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const rows = await c.env.DB.prepare(`
    SELECT f.*, c.title as category_title
    FROM feeds f
    LEFT JOIN categories c ON c.id = f.category_id
    WHERE f.user_id = 'anonymous'
    ORDER BY f.sort_order ASC
  `).all<any>()
  return c.json((rows.results || []).map(feedToMiniflux))
})

// ── GET /v1/feeds/counters — MUST be before /v1/feeds/:id ────────────────────

miniflux.get('/v1/feeds/counters', async (c) => {
  if (!verifyAuth(c)) return unauth(c)

  const rows = await c.env.DB.prepare(`
    SELECT a.feed_id,
      SUM(CASE WHEN COALESCE(s.is_read, 0) = 0 THEN 1 ELSE 0 END) as unread,
      SUM(CASE WHEN s.is_read = 1 THEN 1 ELSE 0 END) as read_count
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_states s ON s.article_id = a.id AND s.user_id = 'anonymous'
    WHERE f.user_id = 'anonymous'
    GROUP BY a.feed_id
  `).all<{ feed_id: number; unread: number; read_count: number }>()

  const unreads: Record<string, number> = {}
  const reads: Record<string, number> = {}

  for (const row of rows.results || []) {
    unreads[String(row.feed_id)] = row.unread || 0
    reads[String(row.feed_id)]   = row.read_count || 0
  }

  return c.json({ reads, unreads })
})

// ── GET /v1/feeds/:id ────────────────────────────────────────────────────────

miniflux.get('/v1/feeds/:id', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const row = await c.env.DB.prepare(`
    SELECT f.*, c.title as category_title
    FROM feeds f LEFT JOIN categories c ON c.id = f.category_id
    WHERE f.id = ? AND f.user_id = 'anonymous'
  `).bind(Number(c.req.param('id'))).first<any>()
  if (!row) return c.json({ error_message: 'Feed not found', error_type: 'not_found' }, 404)
  return c.json(feedToMiniflux(row))
})

// ── GET /v1/entries ──────────────────────────────────────────────────────────

miniflux.get('/v1/entries', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  return listEntries(c, null)
})

// ── GET /v1/feeds/:feedId/entries ────────────────────────────────────────────

miniflux.get('/v1/feeds/:feedId/entries', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  return listEntries(c, Number(c.req.param('feedId')))
})

// ── GET /v1/entries/:id ──────────────────────────────────────────────────────

miniflux.get('/v1/entries/:id', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const row = await c.env.DB.prepare(`
    SELECT a.*, f.title as feed_title, f.site_url as feed_site_url, f.url as feed_url,
      COALESCE(s.is_read, 0) as is_read, COALESCE(s.is_starred, 0) as is_starred
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_states s ON s.article_id = a.id AND s.user_id = 'anonymous'
    WHERE a.id = ?
  `).bind(Number(c.req.param('id'))).first<any>()
  if (!row) return c.json({ error_message: 'Entry not found', error_type: 'not_found' }, 404)
  return c.json(articleToMiniflux(row))
})

// ── PUT /v1/entries — batch mark read/unread ─────────────────────────────────

miniflux.put('/v1/entries', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const body = await c.req.json<{ entry_ids: number[]; status: 'read' | 'unread' }>()
  const { entry_ids, status } = body
  if (!entry_ids?.length) return new Response(null, { status: 204 })

  const isRead = status === 'read' ? 1 : 0
  const now = new Date().toISOString()

  for (const id of entry_ids) {
    await c.env.DB.prepare(`
      INSERT INTO article_states (user_id, article_id, is_read, is_starred, read_at, starred_at)
      VALUES ('anonymous', ?, ?, 0, ?, NULL)
      ON CONFLICT (user_id, article_id) DO UPDATE SET is_read = ?, read_at = ?
    `).bind(id, isRead, isRead ? now : null, isRead, isRead ? now : null).run()
  }

  return new Response(null, { status: 204 })
})

// ── PUT /v1/entries/:id/bookmark — toggle star ───────────────────────────────

miniflux.put('/v1/entries/:id/bookmark', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const id = Number(c.req.param('id'))
  const now = new Date().toISOString()

  const existing = await c.env.DB.prepare(
    "SELECT is_starred FROM article_states WHERE user_id = 'anonymous' AND article_id = ?"
  ).bind(id).first<{ is_starred: number }>()

  const newStarred = existing ? (existing.is_starred ? 0 : 1) : 1

  await c.env.DB.prepare(`
    INSERT INTO article_states (user_id, article_id, is_read, is_starred, read_at, starred_at)
    VALUES ('anonymous', ?, 0, ?, NULL, ?)
    ON CONFLICT (user_id, article_id) DO UPDATE SET is_starred = ?, starred_at = ?
  `).bind(id, newStarred, newStarred ? now : null, newStarred, newStarred ? now : null).run()

  return new Response(null, { status: 204 })
})
// ── POST /v1/categories ───────────────────────────────────────────────────────

miniflux.post('/v1/categories', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const { title } = await c.req.json<{ title: string }>()
  const now = new Date().toISOString()
  const result = await c.env.DB.prepare(`
    INSERT INTO categories (user_id, title, created_at, sort_order)
    VALUES ('anonymous', ?, ?, 0)
  `).bind(title, now).run()
  const row = await c.env.DB.prepare(
    "SELECT id, title FROM categories WHERE rowid = last_insert_rowid()"
  ).first<{ id: number; title: string }>()
  return c.json({ id: row?.id, title: row?.title, user_id: 1, hide_globally: false }, 201)
})

// ── POST /v1/feeds ────────────────────────────────────────────────────────────

miniflux.post('/v1/feeds', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const body = await c.req.json<{ feed_url: string; title?: string; category_id?: number }>()
  const now = new Date().toISOString()
  await c.env.DB.prepare(`
    INSERT INTO feeds (user_id, url, title, site_url, description, created_at, sort_order, etag, last_modified, error_count, category_id)
    VALUES ('anonymous', ?, ?, '', '', ?, 0, '', '', 0, ?)
    ON CONFLICT (user_id, url) DO NOTHING
  `).bind(body.feed_url, body.title || body.feed_url, now, body.category_id || null).run()
  const row = await c.env.DB.prepare(
    "SELECT * FROM feeds WHERE user_id = 'anonymous' AND url = ?"
  ).bind(body.feed_url).first<any>()
  return c.json(feedToMiniflux(row), 201)
})

// ── DELETE /v1/feeds/:id ──────────────────────────────────────────────────────

miniflux.delete('/v1/feeds/:id', async (c) => {
  if (!verifyAuth(c)) return unauth(c)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare("DELETE FROM feeds WHERE id = ? AND user_id = 'anonymous'").bind(id).run()
  return new Response(null, { status: 204 })
})
// ── Helpers ──────────────────────────────────────────────────────────────────

async function listEntries(c: any, feedId: number | null) {
  const db = c.env.DB as any
  const url = new URL(c.req.url)
  const status     = url.searchParams.get('status')
  const limit      = Math.min(Number(url.searchParams.get('limit')  || 100), 1000)
  const offset     = Number(url.searchParams.get('offset') || 0)
  const direction  = url.searchParams.get('direction') === 'asc' ? 'ASC' : 'DESC'
  const categoryId = url.searchParams.get('category_id')

  let where = "f.user_id = 'anonymous'"
  const params: any[] = []

  if (feedId !== null)  { where += ' AND a.feed_id = ?';     params.push(feedId) }
  if (categoryId)       { where += ' AND f.category_id = ?'; params.push(Number(categoryId)) }
  if (status === 'unread')       where += ' AND COALESCE(s.is_read, 0) = 0'
  else if (status === 'read')    where += ' AND s.is_read = 1'
  else if (status === 'starred') where += ' AND s.is_starred = 1'

  const countRow = await db.prepare(`
    SELECT COUNT(*) as count FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_states s ON s.article_id = a.id AND s.user_id = 'anonymous'
    WHERE ${where}
  `).bind(...params).first()

  const rows = await db.prepare(`
    SELECT a.*, f.title as feed_title, f.site_url as feed_site_url, f.url as feed_url,
      COALESCE(s.is_read, 0) as is_read, COALESCE(s.is_starred, 0) as is_starred
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_states s ON s.article_id = a.id AND s.user_id = 'anonymous'
    WHERE ${where}
    ORDER BY COALESCE(a.published_at, a.created_at) ${direction}
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all()

  return c.json({
    total: countRow?.count || 0,
    entries: (rows.results || []).map(articleToMiniflux),
  })
}

function feedToMiniflux(f: any) {
  return {
    id: f.id,
    user_id: 1,
    title: f.title,
    site_url: f.site_url || '',
    feed_url: f.url,
    description: f.description || '',
    checked_at: f.last_updated || f.created_at,
    next_check_at: '0001-01-01T00:00:00Z',
    etag_header: f.etag || '',
    last_modified_header: f.last_modified || '',
    parsing_error_count: f.error_count || 0,
    parsing_error_message: f.last_error || '',
    scraper_rules: '', rewrite_rules: '', crawler: false,
    blocklist_rules: '', keeplist_rules: '', user_agent: '',
    username: '', password: '', disabled: false,
    ignore_http_cache: false, fetch_via_proxy: false,
    hide_globally: false, no_media_player: false,
    disable_http2: false, allow_self_signed_certificates: false,
    ignore_entry_updates: false, cookie: '',
    urlrewrite_rules: '', block_filter_entry_rules: '',
    keep_filter_entry_rules: '', apprise_service_urls: '',
    webhook_url: '', ntfy_enabled: false, ntfy_priority: 0,
    ntfy_topic: '', pushover_enabled: false, pushover_priority: 0,
    proxy_url: '',
    category: f.category_id
      ? { id: f.category_id, title: f.category_title || 'Uncategorized', user_id: 1, hide_globally: false }
      : { id: 0, title: 'Uncategorized', user_id: 1, hide_globally: false },
    icon: { feed_id: f.id, icon_id: 0, external_icon_id: '' },
  }
}

function articleToMiniflux(a: any) {
  const feed = {
    id: a.feed_id, user_id: 1,
    title: a.feed_title || '',
    site_url: a.feed_site_url || '',
    feed_url: a.feed_url || '',
    description: '', checked_at: '',
    next_check_at: '0001-01-01T00:00:00Z',
    etag_header: '', last_modified_header: '',
    parsing_error_count: 0, parsing_error_message: '',
    scraper_rules: '', rewrite_rules: '', crawler: false,
    blocklist_rules: '', keeplist_rules: '', user_agent: '',
    username: '', password: '', disabled: false,
    ignore_http_cache: false, fetch_via_proxy: false,
    hide_globally: false, no_media_player: false,
    disable_http2: false, allow_self_signed_certificates: false,
    ignore_entry_updates: false, cookie: '',
    urlrewrite_rules: '', block_filter_entry_rules: '',
    keep_filter_entry_rules: '', apprise_service_urls: '',
    webhook_url: '', ntfy_enabled: false, ntfy_priority: 0,
    ntfy_topic: '', pushover_enabled: false, pushover_priority: 0,
    proxy_url: '',
    category: { id: 0, title: 'Uncategorized', user_id: 1, hide_globally: false },
    icon: { feed_id: a.feed_id, icon_id: 0, external_icon_id: '' },
  }
  return {
    id: a.id,
    user_id: 1,
    feed_id: a.feed_id,
    title: a.title || '(no title)',
    url: a.url,
    comments_url: '',
    author: a.author || '',
    content: a.content || a.summary || '',
    hash: a.guid || String(a.id),
    published_at: a.published_at || a.created_at,
    created_at: a.created_at,
    changed_at: a.created_at,
    status: a.is_read ? 'read' : 'unread',
    share_code: '',
    starred: Boolean(a.is_starred),
    reading_time: 1,
    enclosures: [],
    feed,
    tags: [],
  }
}
