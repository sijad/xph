# xph website

Static package website, deployed to https://sijad.github.io/xph/ by
`.github/workflows/pages.yml`. No build step or JavaScript runtime is required.
All local asset URLs are relative so the site supports both `/xph/` and `/`.

## Preview

From the repository root, run `python3 -m http.server 8000` and open
http://localhost:8000/website/.

## GitHub Pages

Push this repository to `sijad/xph`. In **Settings → Pages → Build and deployment**,
choose **GitHub Actions** as the source. Push website changes to `main`, or run
the **Deploy website to GitHub Pages** workflow manually.

## Move to xph.js.org

1. Arrange the `xph.js.org` DNS entry through the js.org domain process.
2. Set `xph.js.org` as the custom domain in the repository's Pages settings and
   enable HTTPS once the certificate is available.
3. Add `website/CNAME` containing `xph.js.org` so the deployed artifact retains
   the custom domain.
4. Change the canonical link and `og:url` in `index.html` to
   `https://xph.js.org/`, and update the website links in both package READMEs.

No base-path rebuild is necessary. Do not add a CNAME until the custom domain
is ready.
