#!/usr/bin/env node
// Builds static blog pages for acaiboutique.co.il from the Soro blog embed.
// Lives next to (not inside) the deployable site/ folder so it is never publicly served.
//
//   node build-blog.js            fetch posts from Soro -> data/posts.json -> build -> verify
//   node build-blog.js --offline  build from the existing data/posts.json (no network)
//   node build-blog.js --verify   only run the verification + link check
//
// Generated output in site/ (safe to delete, fully rebuilt on every run):
//   blog/<slug>/index.html, blog/page/<n>/index.html (only if pagination kicks in)
// Rewritten in place: site/blog.html, site/sitemap.xml, the marked block in site/_redirects.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'site');
const SITE = 'https://acaiboutique.co.il';
const SORO_TOKEN = '2decff5c-cbe3-4a14-b925-3c69064516f6';
const SORO_EMBED = process.env.SORO_EMBED_URL || `https://app.trysoro.com/api/embed/${SORO_TOKEN}`;
const ORG_ID = `${SITE}/#organization`;
const PAGE_SIZE = 48; // posts per index page; pagination only appears above this
const RELATED_COUNT = 3;
const DATA_FILE = path.join(__dirname, 'data', 'posts.json');
// Soro slug -> slug used on the site. The old slug gets 301s to the new URL.
const SLUG_OVERRIDES = {
  'duchan-acai-leirועים': 'duchan-acai-leiruim', // mixed Latin/Hebrew slug from Soro
};
const BLOG_DIR = path.join(ROOT, 'blog');

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const VERIFY_ONLY = args.includes('--verify');
const IN_CI = process.env.NETLIFY === 'true' || !!process.env.CI;

// ---------- helpers ----------
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => {
  const p = path.join(ROOT, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const postPath = (slug) => `/blog/${slug}/`;                // decoded, for the filesystem
const postHref = (slug) => encodeURI(postPath(slug));       // percent-encoded, for HTML/XML
const postUrl = (slug) => SITE + postHref(slug);
const pageHref = (n) => (n === 1 ? '/blog' : `/blog/page/${n}/`);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hebDate = (iso) => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const stripTags = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
const wordCount = (h) => stripTags(h).split(/\s+/).filter(Boolean).length;
function must(re, src, name) {
  const m = src.match(re);
  if (!m) throw new Error(`Template piece not found in blog.html: ${name}`);
  return m[0];
}
function safeSlug(slug) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch { /* already decoded */ }
  s = s.normalize('NFC').trim();
  if (!s || /[\/\\?#<>"]|\.\./.test(s)) throw new Error(`Unsafe slug: ${slug}`);
  return s;
}

// ---------- 1. fetch from Soro ----------
async function fetchPosts() {
  console.log(`Fetching ${SORO_EMBED}`);
  const res = await fetch(SORO_EMBED);
  if (!res.ok) throw new Error(`Soro embed returned ${res.status}`);
  const js = await res.text();
  const start = js.indexOf('var SORO_ARTICLES = ');
  if (start < 0) throw new Error('SORO_ARTICLES not found in embed script (Soro changed its format?)');
  const end = js.indexOf('];', start);
  const articles = JSON.parse(js.slice(start + 'var SORO_ARTICLES = '.length, end + 1));
  // An empty list from Soro is treated as an outage, not "delete every post".
  if (!articles.length) throw new Error('Soro returned 0 articles');
  console.log(`Found ${articles.length} articles; fetching content...`);

  // Article bodies are not in the list (content: null); the widget loads them per id.
  const queue = [...articles];
  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      if (a.content) continue;
      const r = await fetch(`${SORO_EMBED}/article/${a.id}`);
      if (!r.ok) throw new Error(`Article ${a.slug} (${a.id}) returned ${r.status}`);
      a.content = (await r.json()).content;
      if (!a.content) throw new Error(`Article ${a.slug} has empty content`);
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));

  const data = { source: SORO_EMBED, fetchedAt: new Date().toISOString(), articles };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Saved data/posts.json (${articles.length} posts)`);
  return data;
}

// ---------- template pieces from blog.html ----------
function loadTemplate() {
  const src = read('blog.html');
  const t = {
    style: must(/<style>[\s\S]*?<\/style>/, src, 'main <style>'),
    gtag: must(/<!-- Google tag \(gtag\.js\)[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/, src, 'gtag snippet'),
    nav: must(/<nav class="top"[\s\S]*?<\/nav>/, src, 'top nav'),
    pageHero: must(/<header class="page-hero"[\s\S]*?<\/header>/, src, 'page hero'),
    finalCta: must(/<div class="wrap" style="padding-bottom:20px;">\s*<section class="final"[\s\S]*?<\/section>\s*<\/div>/, src, 'final CTA'),
    footer: must(/<footer>[\s\S]*?<\/footer>/, src, 'footer'),
    floats: must(/<a class="float-ig"[\s\S]*?<\/a>\s*<a class="float-wa"[\s\S]*?<\/a>/, src, 'floating buttons'),
    tailScript: must(/<script>\s*function sendToWhatsapp[\s\S]*?<\/script>/, src, 'tail script'),
  };
  const ld = JSON.parse(must(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, src, 'JSON-LD').replace(/^<script[^>]*>|<\/script>$/g, ''));
  t.org = ld['@graph'].find((n) => n['@type'] === 'Organization');
  t.website = ld['@graph'].find((n) => n['@type'] === 'WebSite');
  if (!t.org || t.org['@id'] !== ORG_ID || !t.website) throw new Error('Organization/WebSite JSON-LD not found in blog.html');
  // Blog-only CSS lives in its own block so the shared site <style> stays byte-identical.
  const extra = src.match(/<style id="blog-extra">[\s\S]*?<\/style>/);
  t.blogCss = extra ? extra[0] : null;
  return t;
}

const BLOG_CSS = `<style id="blog-extra">
.post-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:32px;}
.post-card{display:flex;flex-direction:column;border:1px solid var(--hair);border-radius:20px;overflow:hidden;background:#fff;transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;}
.post-card:hover{transform:translateY(-4px);box-shadow:0 14px 30px rgba(47,24,78,.10);border-color:rgba(47,24,78,.2);}
.post-card-img{aspect-ratio:16/9;background:#F3EEF6;overflow:hidden;}
.post-card-img img{width:100%;height:100%;object-fit:cover;}
.post-card-body{padding:20px 22px 24px;display:flex;flex-direction:column;flex:1;}
.post-card time{font-size:12.5px;font-weight:700;color:var(--cream-text);}
.post-card h2,.post-card h3{font-size:18px;font-weight:800;color:var(--purple);line-height:1.35;margin:8px 0;}
.post-card p{color:var(--text-soft);font-size:14.5px;line-height:1.65;}
.post-card .more{margin-top:auto;padding-top:14px;font-weight:700;color:var(--cream-text);font-size:14px;}
.pager{display:flex;gap:8px;justify-content:center;margin-top:40px;flex-wrap:wrap;}
.pager a,.pager span{padding:9px 16px;border-radius:100px;border:1px solid var(--hair);font-weight:700;font-size:14px;color:var(--purple);}
.pager [aria-current]{background:var(--purple);color:#fff;}
.post-hero{padding-bottom:24px;}
.post-hero .section-tag{display:inline-block;}
.post-meta{margin-top:16px;font-size:14px;color:var(--text-soft);}
.post-cover{border-radius:24px;overflow:hidden;background:#F3EEF6;aspect-ratio:16/9;max-width:900px;}
.post-cover img{width:100%;height:100%;object-fit:cover;}
.post-body{max-width:760px;font-size:17px;}
.post-body>*+*{margin-top:14px;}
.post-body h2{font-size:clamp(22px,2.8vw,28px);font-weight:800;color:var(--purple);line-height:1.3;margin-top:38px;}
.post-body h3{font-size:19px;font-weight:700;color:var(--purple);line-height:1.35;margin-top:28px;}
.post-body h4{font-size:17px;font-weight:700;color:var(--purple);margin-top:22px;}
.post-body ol{padding-inline-start:22px;}
.post-body blockquote{border-inline-start:4px solid var(--cream-deep);padding:6px 18px;color:var(--text-soft);}
.post-body img{border-radius:16px;}
.post-body table{border-collapse:collapse;width:100%;font-size:15px;}
.post-body th,.post-body td{border:1px solid var(--hair);padding:10px 12px;text-align:start;}
@media(max-width:860px){.post-grid{grid-template-columns:1fr;}}
</style>`;

// ---------- page shell ----------
function head(t, m) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(m.title)}</title>
<meta name="description" content="${esc(m.description)}">
<link rel="canonical" href="${esc(m.canonical)}">
${m.prev ? `<link rel="prev" href="${SITE}${m.prev}">\n` : ''}${m.next ? `<link rel="next" href="${SITE}${m.next}">\n` : ''}<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#2F184E">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:locale" content="he_IL">
<meta property="og:type" content="${m.ogType}">
<meta property="og:site_name" content="Acai Boutique">
<meta property="og:title" content="${esc(m.ogTitle || m.title)}">
<meta property="og:description" content="${esc(m.description)}">
<meta property="og:url" content="${esc(m.canonical)}">
<meta property="og:image" content="${esc(m.image)}">
${m.imageSize ? `<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n` : ''}<meta property="og:image:alt" content="${esc(m.imageAlt)}">
${m.published ? `<meta property="article:published_time" content="${esc(m.published)}">\n<meta property="article:author" content="Acai Boutique">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(m.ogTitle || m.title)}">
<meta name="twitter:description" content="${esc(m.description)}">
<meta name="twitter:image" content="${esc(m.image)}">
<meta name="twitter:image:alt" content="${esc(m.imageAlt)}">
<link rel="preload" href="/fonts/rubik-hebrew.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/heebo-hebrew.woff2" as="font" type="font/woff2" crossorigin>
${m.preloadImage ? `<link rel="preload" as="image" href="${esc(m.preloadImage)}">\n` : ''}${t.style}
${BLOG_CSS}
${t.gtag}</head>
<body>
<a class="skip" href="#main">דלגו לתוכן</a>
${t.nav}
`;
}

function tail(t, graph) {
  return `${t.footer}
${t.floats}
${jsonLd({ '@context': 'https://schema.org', '@graph': graph })}
${t.tailScript}
</body>
</html>
`;
}

function breadcrumbs(items) {
  return `<div class="wrap breadcrumbs"><nav aria-label="פירורי לחם"><ol>${items
    .map((it) => (it.href ? `<li><a href="${esc(it.href)}">${esc(it.name)}</a></li>` : `<li aria-current="page">${esc(it.name)}</li>`))
    .join('')}</ol></nav></div>`;
}

function card(p, headingTag, eager) {
  return `<a class="post-card" href="${postHref(p.slug)}">
  <div class="post-card-img"><img src="${esc(p.image)}" alt="${esc(p.title)}" width="800" height="450" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></div>
  <div class="post-card-body">
    <time datetime="${esc(p.isoDate)}">${esc(p.date)}</time>
    <${headingTag}>${esc(p.title)}</${headingTag}>
    <p>${esc(p.excerpt)}</p>
    <span class="more">לקריאת המאמר ←</span>
  </div>
</a>`;
}

// ---------- content cleanup ----------
function cleanContent(html, slugs) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(\/?)h1(\s|>)/gi, '<$1h2$2') // the post title is the page's only h1
    .replace(/\son[a-z]+="[^"]*"/gi, '')
    // Old widget links (/blog?post=slug) -> new static URLs
    .replace(/href="(?:https?:\/\/(?:www\.)?acaiboutique\.co\.il)?\/blog\/?\?post=([^"&#]+)"/gi, (m, s) => {
      let slug;
      try { slug = safeSlug(s.replace(/&amp;/g, '&')); } catch { return m; }
      slug = SLUG_OVERRIDES[slug] || slug;
      return slugs.has(slug) ? `href="${postHref(slug)}"` : m;
    })
    // Same-site absolute links -> root-relative
    .replace(/href="https?:\/\/(?:www\.)?acaiboutique\.co\.il(\/[^"]*)?"/gi, (m, p) => `href="${p || '/'}"`);
}

// ---------- related posts ----------
const STOP = new Set('של את על עם או גם כל לא זה זו הוא היא אם כי מה איך למה כך יותר הם הן אתם לכם שלכם שלך לאירוע לאירועים באירוע אירוע אירועים'.split(' '));
const tokens = (p) => new Set(`${p.title} ${p.slug}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)));
function related(post, posts) {
  const mine = tokens(post);
  const t0 = Date.parse(post.isoDate);
  return posts
    .filter((p) => p.slug !== post.slug)
    .map((p) => {
      let score = 0;
      for (const w of tokens(p)) if (mine.has(w)) score++;
      return { p, score, dist: Math.abs(Date.parse(p.isoDate) - t0) };
    })
    .sort((a, b) => b.score - a.score || a.dist - b.dist)
    .slice(0, RELATED_COUNT)
    .map((x) => x.p);
}

// ---------- 2. post pages ----------
function renderPost(t, post, posts, slugs) {
  const canonical = postUrl(post.slug);
  const title = `${post.title} | Acai Boutique`;
  const body = cleanContent(post.content, slugs);
  const rel = related(post, posts);
  const graph = [
    t.org,
    t.website,
    {
      '@type': 'BlogPosting',
      '@id': `${canonical}#article`,
      headline: post.title,
      description: post.excerpt,
      datePublished: post.isoDate,
      dateModified: post.isoDate,
      image: post.image ? [post.image] : undefined,
      inLanguage: 'he-IL',
      wordCount: wordCount(body),
      author: { '@id': ORG_ID },
      publisher: { '@id': ORG_ID },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      isPartOf: { '@type': 'Blog', '@id': `${SITE}/blog#blog`, name: 'הבלוג של Acai Boutique', url: `${SITE}/blog` },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'בית', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'בלוג', item: `${SITE}/blog` },
        { '@type': 'ListItem', position: 3, name: post.title, item: canonical },
      ],
    },
  ];
  return (
    head(t, {
      title, ogTitle: post.title, description: post.excerpt, canonical, ogType: 'article',
      image: post.image || `${SITE}/og-image.jpg`, imageSize: !post.image, imageAlt: post.title,
      published: post.isoDate, preloadImage: post.image,
    }) +
    `${breadcrumbs([{ name: 'בית', href: '/' }, { name: 'בלוג', href: '/blog' }, { name: post.title }])}
<main id="main">
<article class="post">
  <header class="page-hero post-hero">
    <div class="wrap">
      <a class="section-tag" href="/blog">הבלוג של Acai Boutique</a>
      <h1>${esc(post.title)}</h1>
      <p class="lead">${esc(post.excerpt)}</p>
      <p class="post-meta">פורסם ב-<time datetime="${esc(post.isoDate)}">${esc(post.date)}</time> · Acai Boutique</p>
    </div>
  </header>
  <div class="wrap">
${post.image ? `    <figure class="post-cover"><img src="${esc(post.image)}" alt="${esc(post.title)}" width="1200" height="675" fetchpriority="high" decoding="async"></figure>\n` : ''}    <div class="prose post-body">
${body}
    </div>
  </div>
</article>
<section class="related">
  <div class="wrap">
    <span class="section-tag">עוד מהבלוג</span>
    <h2 class="section-h">מאמרים נוספים שיעניינו אתכם</h2>
    <div class="post-grid">
${rel.map((p) => card(p, 'h3', false)).join('\n')}
    </div>
    <p style="margin-top:28px;"><a class="btn btn-ghost" href="/blog">לכל המאמרים בבלוג</a></p>
  </div>
</section>
${t.finalCta}
</main>
` +
    tail(t, graph)
  );
}

// ---------- 3. blog index (+ pagination when > PAGE_SIZE) ----------
function renderIndex(t, posts, n, pages) {
  const slice = posts.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
  const canonical = SITE + pageHref(n);
  const baseTitle = 'הבלוג של Acai Boutique | טיפים לאירועים, אסאי ובריאות';
  const title = n === 1 ? baseTitle : `${baseTitle} – עמוד ${n}`;
  const description = 'מאמרים וטיפים מ-Acai Boutique: תכנון עמדות אוכל וקינוחים לאירועים, אסאי, תזונה ואורח חיים בריא.';
  const hero = n === 1 ? t.pageHero : t.pageHero.replace(/<h1>([\s\S]*?)<\/h1>/, `<h1>$1 – עמוד ${n}</h1>`);
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="עמודי הבלוג">${Array.from({ length: pages }, (_, i) => i + 1)
          .map((i) => (i === n ? `<span aria-current="page">${i}</span>` : `<a href="${pageHref(i)}">${i}</a>`))
          .join('')}</nav>`
      : '';
  const graph = [
    t.org,
    t.website,
    {
      '@type': 'CollectionPage',
      '@id': `${canonical}#webpage`,
      url: canonical,
      name: title,
      description,
      inLanguage: 'he-IL',
      isPartOf: { '@id': `${SITE}/#website` },
      about: { '@id': ORG_ID },
      primaryImageOfPage: { '@type': 'ImageObject', url: `${SITE}/images/hero-acai-bowl-1100.jpg`, width: 1100, height: 470, caption: 'קערת אסאי בקערת קוקוס ממותגת Acai Boutique עם בננה, תות, אוכמניות וקוקוס, מוגשת מהעמדה' },
      breadcrumb: { '@id': `${canonical}#breadcrumb` },
      mainEntity: {
        '@type': 'Blog',
        '@id': `${SITE}/blog#blog`,
        name: 'הבלוג של Acai Boutique',
        url: `${SITE}/blog`,
        publisher: { '@id': ORG_ID },
        blogPost: slice.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: postUrl(p.slug), datePublished: p.isoDate })),
      },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'בית', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'בלוג', ...(n > 1 ? { item: `${SITE}/blog` } : {}) },
        ...(n > 1 ? [{ '@type': 'ListItem', position: 3, name: `עמוד ${n}` }] : []),
      ],
    },
  ];
  return (
    head(t, {
      title, description, canonical, ogType: 'website',
      image: `${SITE}/og-image.jpg`, imageSize: true, imageAlt: 'עמדת אסאי לאירועים של Acai Boutique',
      prev: n > 1 ? pageHref(n - 1) : null, next: n < pages ? pageHref(n + 1) : null,
    }) +
    `${breadcrumbs(n === 1 ? [{ name: 'בית', href: '/' }, { name: 'בלוג' }] : [{ name: 'בית', href: '/' }, { name: 'בלוג', href: '/blog' }, { name: `עמוד ${n}` }])}
<main id="main">
${hero}
<section style="padding-top:10px;">
  <div class="wrap">
    <div class="post-grid">
${slice.map((p, i) => card(p, 'h2', n === 1 && i < 3)).join('\n')}
    </div>
    ${pager}
  </div>
</section>
${t.finalCta}
</main>
` +
    tail(t, graph)
  );
}

// ---------- 4. sitemap ----------
function buildSitemap(posts) {
  const src = read('sitemap.xml');
  const blocks = src.match(/<url>[\s\S]*?<\/url>/g) || [];
  const keep = blocks
    .filter((b) => !/<loc>https:\/\/acaiboutique\.co\.il\/blog\/[^<]+<\/loc>/.test(b)) // drop previously generated post/page URLs
    .map((b) => (/<loc>https:\/\/acaiboutique\.co\.il\/blog<\/loc>/.test(b) ? b.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${today()}</lastmod>`) : b));
  const postBlocks = posts.map(
    (p) => `<url>
    <loc>${esc(postUrl(p.slug))}</loc>
    <lastmod>${p.isoDate.slice(0, 10)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>${p.image ? `\n    <image:image><image:loc>${esc(p.image)}</image:loc></image:image>` : ''}
  </url>`
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  ${[...keep, ...postBlocks].join('\n  ')}
</urlset>
`;
  write('sitemap.xml', xml);
  return keep.length + postBlocks.length;
}

// ---------- 5. _redirects ----------
function buildRedirects(posts) {
  const BEGIN = '# BEGIN blog (generated by build-blog.js - do not edit inside this block)';
  const END = '# END blog';
  const lines = [BEGIN, '/blog.html  /blog  301!'];
  // "!" is required: /blog is served by blog.html, and Netlify skips unforced rules when a file exists.
  // Only requests carrying ?post=<slug> match these rules, so plain /blog is unaffected.
  for (const p of posts) {
    for (const s of p.oldSlug ? [p.slug, p.oldSlug] : [p.slug]) {
      const enc = encodeURIComponent(s);
      lines.push(`/blog  post=${enc}  ${postHref(p.slug)}  301!`);
      if (enc !== s) lines.push(`/blog  post=${s}  ${postHref(p.slug)}  301!`);
    }
    if (p.oldSlug) {
      // Path form of the old slug (encoded and raw), with and without trailing slash.
      for (const from of new Set([postHref(p.oldSlug), postPath(p.oldSlug)])) {
        lines.push(`${from}  ${postHref(p.slug)}  301`);
        lines.push(`${from.replace(/\/$/, '')}  ${postHref(p.slug)}  301`);
      }
    }
  }
  lines.push(END);
  const file = path.join(ROOT, '_redirects');
  let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`);
  existing = existing.replace(re, '').replace(/^\s+|\s+$/g, '');
  // Generated rules go first: Netlify uses the first matching rule.
  fs.writeFileSync(file, lines.join('\n') + '\n' + (existing ? '\n' + existing + '\n' : ''), 'utf8');
  return lines.length - 2;
}

// ---------- 6. footer ----------
function footerListsPosts(t) {
  const info = t.footer.match(/<h2>מידע<\/h2>\s*<ul>([\s\S]*?)<\/ul>/);
  return !!(info && /href="\/blog\/[^"]+"/.test(info[1]));
}

// ---------- 7. verification ----------
function verify() {
  const pages = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'index.html') pages.push(p);
    }
  };
  if (fs.existsSync(BLOG_DIR)) walk(BLOG_DIR);
  pages.unshift(path.join(ROOT, 'blog.html'));

  // Map every servable URL path -> file, mimicking Netlify's pretty-URL resolution.
  const resolve = (urlPath) => {
    let p;
    try { p = decodeURIComponent(urlPath); } catch { return null; }
    const cands = p === '/' ? ['index.html'] : p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
    for (const c of cands) {
      const f = path.join(ROOT, c);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    return null;
  };
  const idCache = new Map();
  const ids = (f) => {
    if (!idCache.has(f)) idCache.set(f, new Set([...fs.readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    return idCache.get(f);
  };

  let failures = 0;
  const external = new Set();
  const rows = [];
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || '';
    const h1 = (html.match(/<h1[\s>]/g) || []).length;
    const main = (html.match(/<main[\s\S]*<\/main>/) || [''])[0];
    const words = wordCount(main);
    let ldOk = true;
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    for (const m of ldBlocks) { try { JSON.parse(m[1]); } catch { ldOk = false; } }
    if (!ldBlocks.length) ldOk = false;
    const problems = [];
    if (h1 !== 1) problems.push(`h1=${h1}`);
    if (!ldOk) problems.push('JSON-LD invalid');
    if (!title) problems.push('no title');
    if (!/<html lang="he" dir="rtl">/.test(html)) problems.push('lang/dir');
    if (/trysoro/.test(html)) problems.push('Soro embed still present');
    if (rel.startsWith('blog/') && !rel.startsWith('blog/page/')) {
      const expect = SITE + encodeURI('/' + rel.replace(/index\.html$/, ''));
      if (canonical !== expect) problems.push(`canonical mismatch (want ${expect})`);
      if (!/"@type":"BlogPosting"/.test(html) || !/"@type":"BreadcrumbList"/.test(html)) problems.push('missing BlogPosting/Breadcrumb');
      if (!/<article[\s>]/.test(html)) problems.push('no <article>');
    }
    // links
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const u = m[1].replace(/&amp;/g, '&');
      if (/^(tel:|mailto:|data:|#$)/.test(u)) continue;
      if (/^https?:\/\//.test(u)) {
        if (/^https?:\/\/(www\.)?acaiboutique\.co\.il/.test(u)) {
          const p = new URL(u).pathname;
          if (!resolve(p)) problems.push(`broken ${u}`);
        } else external.add(u.split('#')[0]);
        continue;
      }
      if (u.startsWith('#')) { if (!ids(f).has(u.slice(1))) problems.push(`missing anchor ${u}`); continue; }
      const [pth, hash] = u.split('#');
      const target = resolve(pth.split('?')[0]);
      if (!target) problems.push(`broken ${u}`);
      else if (hash && !ids(target).has(hash)) problems.push(`missing anchor ${u}`);
    }
    if (problems.length) failures++;
    rows.push({ rel, title, canonical, h1, words, ldOk, problems });
  }

  console.log('\n=== Verification ===');
  for (const r of rows) {
    console.log(`${r.problems.length ? 'FAIL' : 'ok  '} ${r.rel}\n     title: ${r.title}\n     canonical: ${r.canonical}\n     h1: ${r.h1} | words: ${r.words} | JSON-LD: ${r.ldOk ? 'valid' : 'INVALID'}${r.problems.length ? `\n     problems: ${[...new Set(r.problems)].join('; ')}` : ''}`);
  }
  console.log(`\n${rows.length} pages checked, ${failures} with problems. ${external.size} unique external URLs referenced.`);
  return { failures, external: [...external], rows };
}

async function checkExternal(urls) {
  console.log(`\nChecking ${urls.length} external URLs...`);
  let bad = 0;
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      let status;
      try {
        let r = await fetch(u, { method: 'HEAD', redirect: 'follow' });
        if (r.status === 405 || r.status === 403) r = await fetch(u, { redirect: 'follow' });
        status = r.status;
      } catch (e) { status = e.code || 'ERR'; }
      if (!(status >= 200 && status < 400)) { bad++; console.log(`  ${status} ${u}`); }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(bad ? `${bad} external URL(s) failed.` : 'All external URLs OK.');
  return bad;
}

// ---------- main ----------
async function main() {
  if (!VERIFY_ONLY) {
    const data = await loadData();
    const posts = data.articles
      .map((a) => {
        const soroSlug = safeSlug(a.slug);
        const slug = SLUG_OVERRIDES[soroSlug] ? safeSlug(SLUG_OVERRIDES[soroSlug]) : soroSlug;
        return { ...a, slug, oldSlug: slug !== soroSlug ? soroSlug : null, date: a.date || hebDate(a.isoDate) };
      })
      .filter((a) => a.content && a.title)
      .sort((a, b) => Date.parse(b.isoDate) - Date.parse(a.isoDate));
    const slugs = new Set(posts.map((p) => p.slug));
    if (slugs.size !== posts.length) throw new Error('Duplicate slugs in Soro data');
    if (posts.length !== data.articles.length) console.warn(`Warning: skipped ${data.articles.length - posts.length} posts without content/title`);

    const t = loadTemplate();
    fs.rmSync(BLOG_DIR, { recursive: true, force: true });
    for (const p of posts) write(path.join('blog', p.slug, 'index.html'), renderPost(t, p, posts, slugs));
    const pages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
    for (let n = 1; n <= pages; n++) write(n === 1 ? 'blog.html' : `blog/page/${n}/index.html`, renderIndex(t, posts, n, pages));
    const sm = buildSitemap(posts);
    const rd = buildRedirects(posts);
    console.log(`\nGenerated ${posts.length} post pages, ${pages} index page(s); sitemap: ${sm} URLs; _redirects: ${rd} rules.`);
    console.log(footerListsPosts(t) ? 'Footer "מידע" lists posts - consider updating it.' : 'Footer "מידע" lists no individual posts - left unchanged.');
    console.log('\nPost URLs:');
    for (const p of posts) console.log(`  ${SITE}${postPath(p.slug)}`);
  }
  // Any internal problem fails the build, so Netlify keeps the previous deploy live.
  const { failures, external } = verify();
  const extBad = args.includes('--no-external') ? 0 : await checkExternal(external);
  // A flaky third-party URL shouldn't block scheduled deploys; it only warns on Netlify/CI.
  if (extBad && IN_CI) console.warn('Warning: external URL failures ignored in CI.');
  if (failures || (extBad && !IN_CI)) process.exitCode = 1;
}

// Live Soro data on every build; the committed data/posts.json is the fallback if Soro is down.
async function loadData() {
  const readCache = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (OFFLINE) return readCache();
  try {
    return await fetchPosts();
  } catch (e) {
    if (!fs.existsSync(DATA_FILE)) throw new Error(`Soro fetch failed (${e.message}) and no ${DATA_FILE} to fall back to`);
    console.warn(`Warning: Soro fetch failed (${e.message}); building from data/posts.json`);
    return readCache();
  }
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
