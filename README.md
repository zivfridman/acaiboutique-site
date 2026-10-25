# acaiboutique.co.il

Static site for acaiboutique.co.il, hosted on Netlify (project `harmonious-mooncake-5a2de0`). Netlify deploys automatically from the GitHub repo `acaiboutique-site`.

```
build-blog.js      builds the blog from Soro (Netlify runs it on every deploy)
data/posts.json    last good copy of the Soro posts (fallback if Soro is down)
netlify.toml       build command + publish dir (site/)
site/              the published website
.github/workflows/rebuild.yml   triggers a Netlify rebuild every 6 hours
```

## Publishing a blog post

**Publish it in Soro. That's all.** The site rebuilds automatically every 6 hours and picks up new or edited posts. A GitHub Action calls the Netlify build hook `soro-sync`.

To publish immediately, use one of these:

- `netlify deploy --trigger` from this folder (needs the Netlify CLI and `netlify login`). Note: `netlify build` only builds locally and has no `--trigger` flag.
- POST to the build hook URL: `curl -X POST -d '{}' <hook URL>`. The URL is in Netlify → Project configuration → Build & deploy → Build hooks.
- GitHub → Actions → "Rebuild site from Soro" → Run workflow

## What a build does

`node build-blog.js` runs these steps:

1. Fetches every post live from the Soro embed endpoint. If Soro is unreachable or returns no posts, it falls back to `data/posts.json`.
2. Rebuilds `site/blog/<slug>/` (one page per post), `site/blog.html` (the index), `site/sitemap.xml`, and the generated block in `site/_redirects`. That block holds the 301s from the old `/blog?post=<slug>` URLs.
3. Checks every page: one h1, canonical URL, valid JSON-LD, and no broken internal links. If any check fails, or there's no data at all, the build exits non-zero. Netlify then keeps the previous deploy live.

`data/posts.json` is only refreshed when you build locally and commit it. To refresh the fallback copy, run `node build-blog.js` and commit `data/posts.json`.

Local options:

- `--offline` builds from `data/posts.json` without contacting Soro
- `--verify` runs only the checks
- `--no-external` skips the external-link check (failures there only warn on Netlify)

## Editing

- **Site pages** (`site/index.html`, `site/weddings.html`, …): edit them, commit, push. Netlify deploys on push.
- **Blog design:** the header, nav, styles, footer and CTA are copied from `site/blog.html` on each build, so edit them there. Blog-only CSS is `BLOG_CSS` in `build-blog.js`.
- **Slug changes:** to rename a post URL without editing it in Soro, add it to `SLUG_OVERRIDES` in `build-blog.js`. The old URL gets a 301 automatically. Current override: `duchan-acai-leirועים` → `duchan-acai-leiruim`.
- **Your own redirects:** add them to `site/_redirects` outside the `# BEGIN blog` / `# END blog` block.

## Caveats

- GitHub pauses scheduled workflows after 60 days with no commits in the repo. If that happens, GitHub emails you; re-enable it under the Actions tab.
- Featured images are hosted on Soro's Supabase storage.
- Posts deleted in Soro disappear on the next build. Their old `?post=` URLs then get no redirect.
