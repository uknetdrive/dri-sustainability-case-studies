# Community Knowledge Base for Sustainable Computing

A <a href="https://uknetdrive.github.io/dri-sustainability-case-studies/">community knowledge base</a> of how people are actually tackling sustainability
in digital research infrastructure (DRI), written by software engineers, HPC
facilitators, data scientists, project managers and more.

## Motivation

Trends in carbon emissions from digital research infrastructure (DRI) are a serious concern for people working across this space.

Many pages now exist showing the huge landscape of resources available for this, but it's not always clear what is practically being done by people in roles similar to yours.

This is a knowledge database for people to share how they are tackling sustainability in their job within DRI.

This resource was created as part of the NetDRIVE Community Project EMIT, which is a collaboration between the Scientific Computing Department and the Hartree Centre at STFC to develop training resources for sustainability across DRI.

## How it works

- Articles live in `content/case-studies/` as Markdown with a YAML header.
- Contributors write and preview articles in the browser at `/contribute/write`, then submit them as a GitHub issue, either **for publishing** or **as a draft for discussion**. `.github/workflows/issue-drafts.yml` and `scripts/issue-draft.mjs` handle these issues.
- Edits are checked automatically, and ticking **Ready to publish** in the issue (already ticked when submitted for publishing) or commenting `/publish` opens a review PR. `main` only changes when a maintainer merges a PR.
- Comments on each article are GitHub Discussions.

## Local development

Requires Node 22.12 or newer.

```bash
npm ci
npm run dev        # http://localhost:4321
npm run validate   # what CI runs: type check, schema validation, build, link check
```

## Repository layout

```
content/case-studies/   Articles (Markdown + YAML frontmatter) — contributions go here
templates/              Article template to copy
src/
  content.config.ts     Frontmatter schema 
  lib/taxonomy.ts       Roles 
  lib/articles.ts       Collection queries, sorting, tallies
  lib/url.ts            Base-path-aware internal link helper
  site.config.ts        Org, repo, Giscus and site metadata
  layouts/ components/ pages/ styles/
scripts/check-links.mjs Post-build internal link check
.github/                PR template, issue forms, CI and deploy workflows
```

## Adding a role

Roles are a fixed set, defined in [`src/lib/taxonomy.ts`](src/lib/taxonomy.ts). After editing that file, run `npm run sync:roles` to update the checkboxes in `.github/ISSUE_TEMPLATE/*.yml`.

## Licence

Articles are © their authors, published under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Site code is [MIT](LICENSE) licensed.
