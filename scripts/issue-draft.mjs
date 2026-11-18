#!/usr/bin/env node
/**
 * Parses, validates, and opens publication pull requests for case studies
 * submitted as GitHub issues by the browser editor (`/contribute/write`).
 * Publishing is triggered by ticking "Ready to publish" in the issue, or by
 * commenting `/publish`.
 *
 * Security model:
 *   - Never commits to `main` — `main` only changes when a maintainer merges a PR.
 *   - `--validate-only` runs without `npm ci` and with `contents: read` only.
 *   - `--publish` runs `npm run validate`, pushes an isolated `publish/<slug>`
 *     branch, and opens/updates a PR for maintainer review.
 *   - Raw HTML tags and `javascript:` URLs are rejected in Issue-submitted prose.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GITHUB_OWNER, GITHUB_REPO, REPO_URL } from '../src/site.config.ts';
import { ROLES, ROLE_IDS } from '../src/lib/taxonomy.ts';

const BOT_MARKER = '<!-- dri-draft-bot -->';
const META_RE = /<!--\s*dri-draft-meta:\s*(\{[^\n]*?\})\s*-->/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLE_RE = /^@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/** Today's date in UTC as YYYY-MM-DD. */
export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** Convert an article title into a clean kebab-case filename slug. */
export function slugifyTitle(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'case-study';
}

/** Treat GitHub Issue Form `_No response_` placeholders as empty. */
function cleanOptional(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || /^[_*]No response[_*]$/i.test(trimmed)) return '';
  return trimmed;
}

/** Strip fenced ``` or ~~~ code blocks so prose checks ignore code comments. */
export function stripCodeFences(markdown) {
  return String(markdown ?? '')
    .replace(/^```[\s\S]*?^```\s*$/gm, '')
    .replace(/^~~~[\s\S]*?^~~~\s*$/gm, '');
}

/**
 * Strip fenced code blocks, inline backtick code spans, and standard `<https://...>`
 * autolinks before checking for raw HTML tags in prose.
 */
export function containsRawHtml(markdown) {
  const withoutCodeAndAutolinks = stripCodeFences(markdown)
    .replace(/(`+)[\s\S]*?\1/g, '')
    .replace(/<https?:\/\/[^>\s]+>/gi, '');

  // Catch any HTML tag (including `<svg/onload=...>` without spaces) or HTML comment.
  return /<(?:!--|\/?[a-zA-Z][a-zA-Z0-9:-]*(?:[\s/>]|$))/.test(withoutCodeAndAutolinks);
}

/** Images must be files uploaded to GitHub (by dragging them into the issue). */
const ALLOWED_IMG_SRC_RE = /^https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+$/;
const HTML_IMG_RE = /<img\b([^<>]*?)\/?>/gi;
const MD_IMG_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** True when alt text is missing or is one GitHub filled in automatically. */
export function isWeakAltText(alt) {
  const a = String(alt ?? '').trim();
  return (
    a.length < 3 ||
    /^(image|img|photo|picture|figure|untitled|screenshot|diagram|chart)$/i.test(a) ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(a) ||
    /^screen ?shot(\s+(from|at))?[\s\d_:.,-]*$/i.test(a)
  );
}

/**
 * Check every image in the article (outside code) and return the text with the
 * images removed, so the raw-HTML check that follows does not trip on them.
 */
export function checkImages(markdown) {
  const errors = [];
  const text = stripCodeFences(markdown).replace(/(`+)[\s\S]*?\1/g, '');

  const checkOne = (src, alt) => {
    if (!ALLOWED_IMG_SRC_RE.test(src)) {
      errors.push(
        `**Article content:** the image \`${src.slice(0, 80)}\` is not uploaded to GitHub. Add images by editing this issue and dragging them into the article text.`,
      );
    } else if (isWeakAltText(alt)) {
      errors.push(
        `**Article content:** an image has missing or automatic alt text (\`${String(alt).trim().slice(0, 60) || 'empty'}\`). Replace it with a short description of what the image shows, for people using screen readers.`,
      );
    }
  };

  let rest = text.replace(HTML_IMG_RE, (tag, attrString) => {
    const attrs = new Map();
    const leftover = attrString.replace(/\s+([a-zA-Z-]+)\s*=\s*"([^"]*)"/g, (_m, name, value) => {
      attrs.set(name.toLowerCase(), value);
      return '';
    });
    const unknown = [...attrs.keys()].filter((k) => !['src', 'alt', 'width', 'height'].includes(k));
    const badSize = ['width', 'height'].some((k) => attrs.has(k) && !/^\d{1,5}$/.test(attrs.get(k)));
    if (leftover.trim() || unknown.length > 0 || badSize) {
      errors.push(
        '**Article content:** an image tag contains something other than `src`, `alt`, `width` and `height`. Remove the extra parts, or drag the image into the issue again.',
      );
      return '';
    }
    checkOne(attrs.get('src') ?? '', attrs.get('alt') ?? '');
    return '';
  });
  rest = rest.replace(MD_IMG_RE, (_m, alt, src) => {
    checkOne(src, alt);
    return '';
  });

  return { errors, rest };
}

/**
 * Parse external sources from lines formatted as:
 *   - `Title | https://example.org`
 *   - `[Title](https://example.org)`
 *   - `https://example.org`
 */
export function parseSources(raw) {
  const cleaned = cleanOptional(raw);
  if (!cleaned) return { sources: [], errors: [] };

  const sources = [];
  const errors = [];
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean);

  for (const line of lines) {
    let title = '';
    let rawUrl = '';

    const mdMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(line);
    const pipeMatch = /^(.+?)\s*\|\s*(https?:\/\/\S+)$/.exec(line);
    const dashMatch = /^(.+?)\s+[-–—]\s+(https?:\/\/\S+)$/.exec(line);

    if (mdMatch) {
      title = mdMatch[1].trim();
      rawUrl = mdMatch[2].trim();
    } else if (pipeMatch) {
      title = pipeMatch[1].trim();
      rawUrl = pipeMatch[2].trim();
    } else if (dashMatch) {
      title = dashMatch[1].trim();
      rawUrl = dashMatch[2].trim();
    } else if (/^https?:\/\/\S+$/.test(line)) {
      rawUrl = line;
      try {
        const u = new URL(rawUrl);
        title = `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
      } catch {
        title = rawUrl;
      }
    } else {
      errors.push(
        `Could not parse source line \`${line.slice(0, 80)}\`. Format each source on its own line as \`Title | https://example.org\`.`,
      );
      continue;
    }

    try {
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        errors.push(`Source URL \`${rawUrl}\` must start with https:// or http://.`);
        continue;
      }
      if (!title) {
        errors.push(`Source \`${rawUrl}\` needs a title (e.g. \`Title | ${rawUrl}\`).`);
        continue;
      }
      sources.push({ title, url: parsedUrl.href });
    } catch {
      errors.push(`Source URL \`${rawUrl}\` is not a valid web address.`);
    }
  }

  return { sources, errors };
}

/** Hidden marker the browser editor puts at the top of every case study issue. */
export const ISSUE_MARKER = '<!-- dri-case-study -->';
/** Hidden marker separating the article details from the article itself. */
export const ARTICLE_MARKER = '<!-- article -->';
const READY_RE = /^\s*[-*]\s*\[[xX]\]\s+\*\*Ready to publish\*\*/m;

/** True when the "Ready to publish" tick-box in the issue is ticked. */
export function isReadyToPublish(issueBody) {
  return READY_RE.test(String(issueBody ?? ''));
}

/**
 * Read the `key: value` lines inside the "Article details" code block.
 * Indented lines continue the previous key (used for multi-line `sources`).
 */
function parseDetailsBlock(text) {
  const fields = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const keyMatch = /^([a-z][a-z-]*):[ \t]*(.*)$/i.exec(line);
    if (keyMatch && !/^\s/.test(line)) {
      current = keyMatch[1].toLowerCase();
      fields.set(current, keyMatch[2].trim());
    } else if (current && line.trim()) {
      const prev = fields.get(current);
      fields.set(current, prev ? `${prev}\n${line.trim()}` : line.trim());
    }
  }
  return fields;
}

/**
 * Parse and validate an issue body generated by the browser editor
 * (`src/pages/contribute/write.astro`).
 */
export function parseIssueBody(issueBody, issueAuthorLogin) {
  const raw = String(issueBody ?? '').replace(/\r\n/g, '\n');
  const errors = [];

  const articleIdx = raw.indexOf(ARTICLE_MARKER);
  const detailsMatch = /```[a-z]*\n([\s\S]*?)\n```/.exec(
    articleIdx === -1 ? raw : raw.slice(0, articleIdx),
  );

  if (articleIdx === -1 || !detailsMatch) {
    return {
      valid: false,
      errors: [
        'Could not find the article details and article text in this issue. Please submit case studies from the browser editor on the website, and keep the hidden markers in the issue text when editing.',
      ],
      parsed: null,
    };
  }

  const markdownBody = raw.slice(articleIdx + ARTICLE_MARKER.length).trim();
  const sections = parseDetailsBlock(detailsMatch[1]);

  // 1. Title
  const title = cleanOptional(sections.get('title')).replace(/\s+/g, ' ');
  if (title.length < 8 || title.length > 100) {
    errors.push(
      `**title** must be between 8 and 100 characters (currently ${title.length}).`,
    );
  }

  // 2. Description
  const description = cleanOptional(sections.get('summary')).replace(/\s+/g, ' ');
  if (description.length < 40 || description.length > 300) {
    errors.push(
      `**summary** must be between 40 and 300 characters (currently ${description.length}).`,
    );
  }

  // 3. Roles
  const roleLabelToId = new Map();
  for (const id of ROLE_IDS) {
    roleLabelToId.set(id.toLowerCase(), id);
    roleLabelToId.set(ROLES[id].label.toLowerCase(), id);
  }
  const roles = [];
  for (const token of cleanOptional(sections.get('roles')).split(/[,\n]+/)) {
    const label = token.trim().toLowerCase();
    if (!label) continue;
    const mapped = roleLabelToId.get(label);
    if (!mapped) {
      errors.push(
        `**roles:** \`${token.trim()}\` is not a known role. Use any of: ${ROLE_IDS.join(', ')}.`,
      );
    } else if (!roles.includes(mapped)) {
      roles.push(mapped);
    }
  }
  if (roles.length < 1) {
    errors.push('**roles:** list at least 1 role, separated by commas.');
  }

  // 4. Tags
  const tagsRaw = cleanOptional(sections.get('tags'));
  const rawTagList = tagsRaw
    ? tagsRaw
        .split(/[,\n]+/)
        .map((t) =>
          t
            .trim()
            .replace(/^#+/, '')
            .toLowerCase()
            .replace(/[\s_]+/g, '-'),
        )
        .filter(Boolean)
    : [];
  const tags = [...new Set(rawTagList)];
  if (tags.length < 1) {
    errors.push('**tags:** provide at least 1 tag (comma-separated, lowercase-kebab-case).');
  } else if (tags.length > 8) {
    errors.push(`**tags:** provide at most 8 tags (currently ${tags.length}).`);
  }
  for (const t of tags) {
    if (!KEBAB_RE.test(t)) {
      errors.push(
        `Tag \`${t}\` must use only lowercase letters, numbers, and single hyphens (e.g. \`gpu-profiling\`).`,
      );
    }
  }

  // 5. Organisation
  const organisation = cleanOptional(sections.get('organisation')).replace(/\s+/g, ' ');

  // 6. Author(s): primary author is always the issue creator, plus any co-authors.
  const primaryHandle = `@${String(issueAuthorLogin ?? '').replace(/^@/, '')}`;
  const authors = [primaryHandle];
  const seenAuthors = new Set([primaryHandle.toLowerCase()]);

  const coauthorsRaw = cleanOptional(sections.get('co-authors'));
  if (coauthorsRaw) {
    for (const token of coauthorsRaw.split(/[,\s]+/).filter(Boolean)) {
      const handle = token.startsWith('@') ? token : `@${token}`;
      if (!HANDLE_RE.test(handle)) {
        errors.push(`Co-author \`${token}\` does not look like a valid GitHub handle.`);
        continue;
      }
      if (!seenAuthors.has(handle.toLowerCase())) {
        seenAuthors.add(handle.toLowerCase());
        authors.push(handle);
      }
    }
  }

  // 7. Time-sensitive
  const tsRaw = cleanOptional(sections.get('time-sensitive')).toLowerCase();
  const timeSensitive = tsRaw === 'yes' || tsRaw === 'true';

  // 8. Sources
  const { sources, errors: sourceErrors } = parseSources(sections.get('sources'));
  errors.push(...sourceErrors);

  // 9. Licensing
  if (!/confirmed/i.test(sections.get('licence') ?? '')) {
    errors.push(
      '**licence:** the CC BY 4.0 licence has not been confirmed. Tick the licensing box in the browser editor and submit again.',
    );
  }

  // 10. Web address (optional; the bot falls back to one made from the title)
  const requestedSlug = cleanOptional(sections.get('web-address')).toLowerCase();
  if (requestedSlug && !KEBAB_RE.test(requestedSlug)) {
    errors.push(
      `**web-address:** \`${requestedSlug}\` must use only lowercase letters, numbers and single hyphens.`,
    );
  }

  // 11. Markdown body checks
  const strippedBody = stripCodeFences(markdownBody);
  if (markdownBody.length < 40) {
    errors.push('**Article content:** please write at least a short draft body in Markdown.');
  }
  if (/^#\s+\S/m.test(strippedBody)) {
    errors.push(
      '**Article content:** start headings at `##` rather than `#` — the page `<h1>` title is rendered automatically from **title**.',
    );
  }
  const imageCheck = checkImages(markdownBody);
  errors.push(...imageCheck.errors);
  if (containsRawHtml(imageCheck.rest)) {
    errors.push(
      '**Article content:** HTML tags are not permitted, apart from images dragged into the issue. Use standard Markdown, and wrap code or `<angle-brackets>` in backticks (`` `...` ``).',
    );
  }
  if (/javascript\s*:/i.test(strippedBody.replace(/(`+)[\s\S]*?\1/g, ''))) {
    errors.push('**Article content:** `javascript:` links are not permitted.');
  }

  return {
    valid: errors.length === 0,
    errors,
    parsed: {
      title,
      description,
      roles,
      tags,
      author: authors,
      organisation: organisation || undefined,
      timeSensitive,
      sources,
      slug: requestedSlug || undefined,
      markdownBody,
    },
  };
}

/** Render validated frontmatter + Markdown body matching src/content.config.ts. */
export function renderArticleMarkdown({
  title,
  description,
  roles,
  tags,
  author,
  organisation,
  date,
  timeSensitive,
  sources,
  draft = false,
  draftId,
  markdownBody,
}) {
  const lines = ['---'];
  lines.push(`title: ${JSON.stringify(title)}`);
  lines.push(`description: ${JSON.stringify(description)}`);
  lines.push('roles:');
  for (const r of roles) lines.push(`  - ${r}`);
  lines.push('tags:');
  for (const t of tags) lines.push(`  - ${t}`);

  const authorList = Array.isArray(author) ? author : [author];
  if (authorList.length === 1) {
    lines.push(`author: ${JSON.stringify(authorList[0])}`);
  } else {
    lines.push('author:');
    for (const a of authorList) lines.push(`  - ${JSON.stringify(a)}`);
  }

  if (organisation) {
    lines.push(`organisation: ${JSON.stringify(organisation)}`);
  }

  lines.push(`date: ${date}`);
  lines.push(`timeSensitive: ${Boolean(timeSensitive)}`);

  if (!sources || sources.length === 0) {
    lines.push('sources: []');
  } else {
    lines.push('sources:');
    for (const s of sources) {
      lines.push(`  - title: ${JSON.stringify(s.title)}`);
      lines.push(`    url: ${JSON.stringify(s.url)}`);
    }
  }

  lines.push(`draft: ${Boolean(draft)}`);
  if (draft && draftId) {
    lines.push(`draftId: ${JSON.stringify(draftId)}`);
  }
  lines.push('---', '', String(markdownBody).trim(), '');
  return lines.join('\n');
}

export function extractBotMeta(commentBody) {
  const match = META_RE.exec(String(commentBody ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && typeof parsed.slug === 'string' && KEBAB_RE.test(parsed.slug)) {
      return parsed;
    }
  } catch {
    // Ignore malformed metadata comment.
  }
  return null;
}

function buildComment(meta, bodyLines) {
  const header = [BOT_MARKER];
  if (meta) header.push(`<!-- dri-draft-meta: ${JSON.stringify(meta)} -->`);
  return [...header, ...bodyLines].join('\n');
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function ghApi(endpoint, { method = 'GET', body } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for GitHub API calls.');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, data };
}

async function findBotComment(issueNumber) {
  const { ok, data } = await ghApi(`/issues/${issueNumber}/comments?per_page=100`);
  if (!ok || !Array.isArray(data)) return null;
  return (
    data.find(
      (c) =>
        c?.user?.login === 'github-actions[bot]' &&
        typeof c.body === 'string' &&
        c.body.includes(BOT_MARKER),
    ) ?? null
  );
}

async function upsertBotComment(issueNumber, existingComment, content) {
  if (existingComment) {
    await ghApi(`/issues/comments/${existingComment.id}`, {
      method: 'PATCH',
      body: { body: content },
    });
  } else {
    await ghApi(`/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: { body: content },
    });
  }
}

async function postIssueComment(issueNumber, content) {
  await ghApi(`/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: { body: content },
  });
}

function runValidate() {
  try {
    execFileSync('npm', ['run', 'validate'], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output: '' };
  } catch (err) {
    const combined = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    const clean = combined.replace(/\x1B\[[0-9;]*m/g, '').slice(-2000);
    return { ok: false, output: clean };
  }
}

async function runCli() {
  const publishMode = process.argv.includes('--publish');

  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) {
    throw new Error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must be set.');
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const issue = event.issue;
  if (!issue || issue.pull_request || issue.state !== 'open') return;

  const labels = new Set((issue.labels ?? []).map((l) => l.name));
  const hasMarker = String(issue.body ?? '').includes(ISSUE_MARKER);
  if (!labels.has('article-draft') && !hasMarker) return;

  // Editing only the issue title must not re-run checks or re-push the PR.
  if (eventName === 'issues' && event.action === 'edited' && !event.changes?.body) return;

  const ready = isReadyToPublish(issue.body);

  const issueNumber = issue.number;
  const issueAuthor = issue.user?.login ?? '';

  // External GitHub users without Triage permission cannot apply template labels
  // themselves, so the bot applies `article-draft` automatically on their behalf.
  if (!labels.has('article-draft')) {
    await ghApi(`/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: { labels: ['article-draft'] },
    });
    labels.add('article-draft');
  }

  // Publishing is triggered either by the "Ready to publish" tick-box (ticked by
  // the browser editor's "Submit for publishing" button, or ticked later on a
  // draft) or by a `/publish` comment. Only the issue author and people with
  // triage access or above can edit an issue, so the tick-box needs no extra check.
  if (publishMode && eventName === 'issues' && !ready) return;
  if (!publishMode && ready) return;

  if (publishMode && eventName === 'issue_comment') {
    if (!/^\s*\/publish\b/im.test(event.comment?.body ?? '')) {
      return;
    }
    const commenter = event.comment?.user?.login ?? '';
    const assoc = event.comment?.author_association ?? '';
    const isMaintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(assoc);
    const isAuthor = commenter.toLowerCase() === issueAuthor.toLowerCase();

    if (!isAuthor && !isMaintainer) {
      await postIssueComment(
        issueNumber,
        `Only @${issueAuthor} or a repository maintainer can run \`/publish\` on this draft.`,
      );
      return;
    }
  }

  const botComment = await findBotComment(issueNumber);
  const existingMeta = botComment ? extractBotMeta(botComment.body) : null;

  const { valid, errors, parsed } = parseIssueBody(issue.body, issueAuthor);

  if (!valid) {
    const msg = buildComment(existingMeta, [
      '### Draft check needs a few tweaks',
      '',
      ...errors.map((e) => `- ${e}`),
      '',
      'Click **••• → Edit** at the top of this issue to fix these in the article details or text. This check runs again automatically when you save.',
    ]);
    await upsertBotComment(issueNumber, botComment, msg);
    return;
  }

  // Validate-only mode (`issues: [opened, edited]`): never writes to git or `main`.
  if (!publishMode) {
    const msg = buildComment(existingMeta, [
      '### ✓ Draft check passed',
      '',
      `- **Author(s):** ${parsed.author.join(', ')}`,
      `- **Target role(s):** ${parsed.roles.join(', ')}`,
      `- **Tags:** ${parsed.tags.map((t) => `\`#${t}\``).join(', ')}`,
      '',
      '**Next steps:**',
      '- **Discuss and revise:** send co-authors this issue link so they can comment, and click **••• → Edit** at the top of this issue to make changes at any time.',
      '- **Ready to publish?** Tick **Ready to publish** at the top of this issue. A pull request then opens automatically for maintainer review.',
    ]);
    await upsertBotComment(issueNumber, botComment, msg);
    return;
  }

  // Publish mode (`/publish` comment): validate full Astro build and open/update PR.
  const contentDir = path.resolve('content/case-studies');
  let slug = existingMeta?.slug;
  if (!slug) {
    const baseSlug = parsed.slug || slugifyTitle(parsed.title);
    slug = existsSync(path.join(contentDir, `${baseSlug}.md`))
      ? `${baseSlug}-${issueNumber}`
      : baseSlug;
    if (existsSync(path.join(contentDir, `${slug}.md`))) {
      slug = `${baseSlug}-${issueNumber}-rev`;
    }
  }

  const filePath = path.join(contentDir, `${slug}.md`);
  if (existsSync(filePath)) {
    await postIssueComment(
      issueNumber,
      `\`content/case-studies/${slug}.md\` already exists on \`main\`. Use **Edit this page on GitHub** at the bottom of the published article to propose updates.`,
    );
    return;
  }

  const publishedMarkdown = renderArticleMarkdown({
    ...parsed,
    date: todayUTC(),
    draft: false,
  });
  writeFileSync(filePath, publishedMarkdown, 'utf8');

  const validation = runValidate();
  if (!validation.ok) {
    if (existsSync(filePath)) unlinkSync(filePath);
    await postIssueComment(
      issueNumber,
      [
        '### Could not prepare publication pull request: site validation failed',
        '',
        '```text',
        validation.output,
        '```',
        '',
        'Please edit the issue above to fix the error. While **Ready to publish** is ticked, saving your edit tries again automatically.',
      ].join('\n'),
    );
    return;
  }

  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');

  const branch = `publish/${slug}`;
  git('checkout', '-B', branch);
  git('add', filePath);
  git('commit', '-m', `Publish case study: ${parsed.title} (#${issueNumber})`);
  git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);

  const meta = { slug };
  const prTitle = `Publish case study: ${parsed.title}`;
  const prBody = [
    `Publishes the case study drafted in #${issueNumber} by ${parsed.author.join(', ')}.`,
    '',
    `- **Target role(s):** ${parsed.roles.join(', ')}`,
    `- **Tags:** ${parsed.tags.join(', ')}`,
    `- **Time-sensitive:** ${parsed.timeSensitive ? 'Yes' : 'No'}`,
    `- **Sources cited:** ${parsed.sources.length}`,
    '',
    `Closes #${issueNumber}`,
  ].join('\n');

  // Record the assigned slug in the status comment so subsequent `/publish` runs reuse the same PR.
  await upsertBotComment(
    issueNumber,
    botComment,
    buildComment(meta, [
      '### ✓ Publication pull request ready',
      '',
      `Branch \`${branch}\` has passed site validation. If you edit this issue again before the pull request is merged, your changes are added to it automatically.`,
    ]),
  );

  const existingPrs = await ghApi(
    `/pulls?state=open&head=${encodeURIComponent(`${GITHUB_OWNER}:${branch}`)}&base=main`,
  );
  if (existingPrs.ok && Array.isArray(existingPrs.data) && existingPrs.data.length > 0) {
    const pr = existingPrs.data[0];
    await ghApi(`/pulls/${pr.number}`, {
      method: 'PATCH',
      body: { title: prTitle, body: prBody },
    });
    await postIssueComment(
      issueNumber,
      `Updated publication pull request **#${pr.number}** (${pr.html_url}) with your latest changes.`,
    );
    return;
  }

  const createdPr = await ghApi('/pulls', {
    method: 'POST',
    body: { title: prTitle, head: branch, base: 'main', body: prBody },
  });

  if (createdPr.ok && createdPr.data?.html_url) {
    await postIssueComment(
      issueNumber,
      `Opened publication pull request **#${createdPr.data.number}** for maintainer review: ${createdPr.data.html_url}`,
    );
  } else {
    const compareUrl = `${REPO_URL}/compare/main...${encodeURIComponent(branch)}?quick_pull=1&title=${encodeURIComponent(prTitle)}&body=${encodeURIComponent(prBody)}`;
    await postIssueComment(
      issueNumber,
      [
        `Pushed branch \`${branch}\`, ready for review:`,
        '',
        ` **[Click here to open the Pull Request](${compareUrl})**`,
        '',
      ].join('\n'),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
