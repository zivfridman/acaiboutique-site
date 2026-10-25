# acaiboutique.co.il – static blog build

The blog posts are written in Soro, but the live site serves them as static pages so Google can index them:

- `blog.html` – the `/blog` index, with every post linked in plain HTML
- `blog/<slug>/index.html` – one page per post, served at `/blog/<slug>/`
- `sitemap.xml` – the 7 site pages plus every post
- `_redirects` – 301s from the old widget URLs (`/blog?post=<slug>`) to the new pages

All of these are produced by `build-blog.js`. Don't edit them by hand.

## After publishing a new post in Soro

Requires Node.js 18 or newer.

```
cd site
node build-blog.js
```

The script:

1. Fetches the Soro embed script and each article's content, then saves the result to `data/posts.json`.
2. Deletes and regenerates `blog/`, rewrites `blog.html` and `sitemap.xml`, and replaces only the generated block in `_redirects`. Any rules you add outside that block are kept.
3. Runs the checks: title, canonical URL, exactly one h1, word count, valid JSON-LD, internal links and anchors, and external URLs. It exits with a non-zero code if anything fails.

Then drag the whole `site` folder onto Netlify (Deploys → drag & drop).

Other modes:

- `node build-blog.js --offline` rebuilds from the saved `data/posts.json` without contacting Soro. Use it after changing the template or the script.
- `node build-blog.js --verify` runs only the checks.
- `--no-external` skips the external URL check.

## Notes

- **Design.** The header, nav, styles, gtag, final CTA, footer and Organization JSON-LD are copied from `blog.html` on every run. To change the design, edit those parts of `blog.html` (they are preserved), then run `--offline`. Blog-only CSS lives in `BLOG_CSS` inside `build-blog.js`.
- **Hebrew slugs.** These are kept as real Hebrew folder names. URLs in the canonical tag, sitemap and links are percent-encoded.
- **Pagination.** It starts automatically above 48 posts (`PAGE_SIZE`), producing `/blog/page/2/` and so on.
- **Deleted posts.** A post deleted in Soro disappears on the next build. Its old `?post=` URL then gets no redirect.
- **Featured images.** These stay on Soro's Supabase storage. If Soro removes them, they break on the site too.
