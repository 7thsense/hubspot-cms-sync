import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { account as realAccount, getAll as realGetAll, hub as realHub } from './lib/hub.mjs';
import { READ_ONLY_PORTAL } from './push.mjs';

const REQUIRED_FIELDS = ['routePrefix', 'destination'];
const BOOLEAN_FIELDS = [
  'isMatchFullUrl',
  'isMatchQueryString',
  'isOnlyAfterNotFound',
  'isPattern',
  'isProtocolAgnostic',
  'isTrailingSlashOptional',
];
const INTEGER_FIELDS = ['redirectStyle', 'precedence'];

function parseBool(value, field, rowNumber) {
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`redirects row ${rowNumber}: ${field} must be true/false`);
}

function parseInteger(value, field, rowNumber) {
  const n = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`redirects row ${rowNumber}: ${field} must be an integer`);
  return n;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

export function parseRedirectCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  for (const field of REQUIRED_FIELDS) {
    if (!header.includes(field)) throw new Error(`redirects CSV is missing required column "${field}"`);
  }
  return rows.slice(1).map((row, idx) => {
    const record = {};
    for (let i = 0; i < header.length; i += 1) record[header[i]] = row[i] ?? '';
    return normalizeRedirect(record, idx + 2);
  });
}

export function normalizeRedirect(input, rowNumber = 1) {
  const out = {};
  for (const field of REQUIRED_FIELDS) {
    const value = String(input[field] ?? '').trim();
    if (!value) throw new Error(`redirects row ${rowNumber}: ${field} is required`);
    out[field] = value;
  }

  out.redirectStyle = input.redirectStyle === undefined || String(input.redirectStyle).trim() === ''
    ? 301
    : parseInteger(input.redirectStyle, 'redirectStyle', rowNumber);

  // We intentionally set this by default so managed redirects can replace an
  // existing live HubSpot page without a UI archive/move step.
  out.isOnlyAfterNotFound = input.isOnlyAfterNotFound === undefined || String(input.isOnlyAfterNotFound).trim() === ''
    ? false
    : parseBool(input.isOnlyAfterNotFound, 'isOnlyAfterNotFound', rowNumber);

  for (const field of BOOLEAN_FIELDS) {
    if (field === 'isOnlyAfterNotFound') continue;
    if (input[field] !== undefined && String(input[field]).trim() !== '') {
      out[field] = parseBool(input[field], field, rowNumber);
    }
  }
  for (const field of INTEGER_FIELDS) {
    if (field === 'redirectStyle') continue;
    if (input[field] !== undefined && String(input[field]).trim() !== '') {
      out[field] = parseInteger(input[field], field, rowNumber);
    }
  }
  return out;
}

export function readRedirectSpecs(file) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error('redirects JSON must be an array');
    return raw.map((r, idx) => normalizeRedirect(r, idx + 1));
  }
  return parseRedirectCsv(text);
}

function payloadFor(spec) {
  const out = {};
  for (const field of ['routePrefix', 'destination', ...INTEGER_FIELDS, ...BOOLEAN_FIELDS]) {
    if (spec[field] !== undefined) out[field] = spec[field];
  }
  return out;
}

export function planRedirects(specs, existing) {
  const seenSpecs = new Set();
  for (const spec of specs) {
    if (seenSpecs.has(spec.routePrefix)) throw new Error(`duplicate managed redirect routePrefix "${spec.routePrefix}"`);
    seenSpecs.add(spec.routePrefix);
  }

  const byRoute = new Map();
  for (const redirect of existing) {
    const route = String(redirect.routePrefix ?? '');
    if (!route) continue;
    if (byRoute.has(route)) throw new Error(`multiple existing HubSpot redirects share routePrefix "${route}"`);
    byRoute.set(route, redirect);
  }

  return specs.map((spec) => {
    const current = byRoute.get(spec.routePrefix);
    if (!current) return { action: 'create', spec, body: payloadFor(spec) };

    const body = payloadFor(spec);
    const changes = {};
    for (const [field, value] of Object.entries(body)) {
      if (String(current[field]) !== String(value)) changes[field] = value;
    }
    if (Object.keys(changes).length === 0) {
      return { action: 'unchanged', id: String(current.id), spec, current };
    }
    return {
      action: 'update',
      id: String(current.id),
      spec,
      current,
      body: changes,
      changedFields: Object.keys(changes),
    };
  });
}

// ---------------------------------------------------------------------------
// RECONCILE mode (prod cutover). HubSpot accounts accumulate years of legacy
// url-redirects stored as full `scheme://host/path` URLs across subdomains. A
// clean managed redirects.csv (path-form) collides with them: same-source stale
// mappings shadow ours, and reverse mappings (dest -> source) make HubSpot reject
// our creates as redirect loops. Reconcile resolves this for OUR managed routes
// ONLY, touching just path-form and www.theseventhsense.com entries (the scope
// where our pages actually serve); legacy entries on other subdomains are left
// untouched. Two rules:
//   A. a managed DESTINATION must resolve, so delete any in-scope redirect whose
//      source path is one of our destinations (removes reverse-loops + shadows).
//   B. a managed SOURCE must redirect to our destination, so update the governing
//      in-scope mapping (deleting any duplicate in-scope mappings that would shadow
//      it) or create one if none exists.
// ---------------------------------------------------------------------------

export const PRIMARY_REDIRECT_HOST = 'www.theseventhsense.com';

// Reduce a routePrefix/destination to a comparable site path: strip scheme+host,
// ensure a single leading slash, preserve the rest (trailing slash is significant —
// /x and /x/ are distinct managed routes). Already-path values pass through.
export function normalizeRedirectPath(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i);
  if (m) s = m[1] || '/';
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

// In-scope = an entry our pages can actually shadow/loop with: path-form, or hosted
// on the primary public domain. Other subdomains (mktg/get/sandbox) are left alone.
export function isInRedirectScope(routePrefix) {
  const rp = String(routePrefix ?? '').trim();
  if (rp.startsWith('/')) return true;
  const m = rp.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);
  return !!m && m[1].toLowerCase() === PRIMARY_REDIRECT_HOST;
}

// Prefer the path-form entry as the one to keep/update, then the primary-host entry.
function preferGoverning(a, b) {
  const aPath = String(a.routePrefix ?? '').startsWith('/');
  const bPath = String(b.routePrefix ?? '').startsWith('/');
  if (aPath !== bPath) return aPath ? a : b;
  return a; // stable: first wins
}

export function planRedirectsReconcile(specs, existing) {
  const seenSpecs = new Set();
  for (const spec of specs) {
    if (seenSpecs.has(spec.routePrefix)) throw new Error(`duplicate managed redirect routePrefix "${spec.routePrefix}"`);
    seenSpecs.add(spec.routePrefix);
  }

  const managedSources = new Set(specs.map((s) => normalizeRedirectPath(s.routePrefix)));
  // Destinations that must resolve as live pages. Root '/' is excluded — we never
  // blind-delete root redirects.
  const managedDests = new Set(
    specs.map((s) => normalizeRedirectPath(s.destination)).filter((p) => p && p !== '/' && !managedSources.has(p)),
  );

  const inScope = existing.filter((r) => isInRedirectScope(r.routePrefix));
  const deletions = [];
  const deletedIds = new Set();

  // Rule A: drop in-scope redirects pointing away from a managed destination.
  for (const r of inScope) {
    const srcPath = normalizeRedirectPath(r.routePrefix);
    if (managedDests.has(srcPath)) {
      deletions.push({ action: 'delete', id: String(r.id), current: r, reason: 'destination-must-resolve' });
      deletedIds.add(String(r.id));
    }
  }

  // Rule B: one governing redirect per managed source.
  const upserts = [];
  for (const spec of specs) {
    const srcPath = normalizeRedirectPath(spec.routePrefix);
    const candidates = inScope.filter(
      (r) => normalizeRedirectPath(r.routePrefix) === srcPath && !deletedIds.has(String(r.id)),
    );
    if (candidates.length === 0) {
      upserts.push({ action: 'create', spec, body: payloadFor(spec) });
      continue;
    }
    const governing = candidates.reduce(preferGoverning);
    // Any other in-scope candidate would shadow the governing one — remove it.
    for (const r of candidates) {
      if (String(r.id) !== String(governing.id) && !deletedIds.has(String(r.id))) {
        deletions.push({ action: 'delete', id: String(r.id), current: r, reason: 'shadow-duplicate' });
        deletedIds.add(String(r.id));
      }
    }
    const wantDest = normalizeRedirectPath(spec.destination);
    const haveDest = normalizeRedirectPath(governing.destination);
    const styleMatches = String(governing.redirectStyle) === String(spec.redirectStyle);
    if (wantDest === haveDest && styleMatches) {
      upserts.push({ action: 'unchanged', id: String(governing.id), spec, current: governing });
    } else {
      upserts.push({
        action: 'update',
        id: String(governing.id),
        spec,
        current: governing,
        body: { destination: spec.destination, redirectStyle: spec.redirectStyle },
        changedFields: ['destination', 'redirectStyle'],
      });
    }
  }

  // Deletes execute first so creates/updates can't loop against a stale mapping.
  return [...deletions, ...upserts];
}

function readOnlySet(config) {
  return new Set((config?.readOnlyPortalIds?.length ? config.readOnlyPortalIds : [READ_ONLY_PORTAL]).map(String));
}

export async function syncRedirects(name, options = {}, deps = {}) {
  const {
    apply = false,
    reconcile = false,
    file,
    config: optionConfig,
  } = options;
  const {
    account = realAccount,
    getAll = realGetAll,
    hub = realHub,
    readSpecs = readRedirectSpecs,
  } = deps;
  const config = deps.config || optionConfig;
  const acct = account(name, config);

  if (apply && readOnlySet(config).has(String(acct.portalId))) {
    throw new Error(
      `portal is read-only: account "${acct.name}" maps to portal ${acct.portalId}; redirects refuses to write`,
    );
  }

  const sourceFile = file || config?.redirectsFilePath;
  if (!sourceFile) {
    throw new Error('redirects requires --file <path> or config.redirectsFile');
  }
  const specs = readSpecs(resolve(config?.root || process.cwd(), sourceFile));
  const existing = await getAll(acct, '/cms/v3/url-redirects');
  const plan = reconcile ? planRedirectsReconcile(specs, existing) : planRedirects(specs, existing);

  // Each managed SOURCE must end up satisfied (created/updated/already-correct).
  // In reconcile mode we continue past individual failures and only fail the run if
  // a managed source is left unsatisfied — a single stale legacy delete must not
  // abort the whole cutover (and skip republish/gates) the way a throw would.
  const failures = [];
  if (apply) {
    for (const item of plan) {
      try {
        if (item.action === 'delete') {
          const r = await hub(acct, 'DELETE', `/cms/v3/url-redirects/${item.id}`);
          // 404 == already gone; treat as success (idempotent).
          if (!r.ok && r.status !== 404) {
            throw new Error(`delete redirect ${item.current?.routePrefix} (${item.id}) -> ${r.status}: ${r.json?.message || ''}`);
          }
        } else if (item.action === 'create') {
          const r = await hub(acct, 'POST', '/cms/v3/url-redirects', item.body);
          if (!r.ok) {
            const msg = r.json?.message || r.json?.category || JSON.stringify(r.json).slice(0, 200);
            throw new Error(`create redirect ${item.spec.routePrefix} -> ${r.status}: ${msg}`);
          }
          item.id = String(r.json?.id ?? '');
        } else if (item.action === 'update') {
          const r = await hub(acct, 'PATCH', `/cms/v3/url-redirects/${item.id}`, item.body);
          if (!r.ok) {
            const msg = r.json?.message || r.json?.category || JSON.stringify(r.json).slice(0, 200);
            throw new Error(`update redirect ${item.spec.routePrefix} (${item.id}) -> ${r.status}: ${msg}`);
          }
        }
      } catch (e) {
        if (!reconcile) throw e;
        failures.push({ item, message: e.message });
      }
    }
  }

  // A managed source is "unsatisfied" only if its own create/update failed; a failed
  // legacy delete (action: 'delete') is logged but does not fail the cutover.
  const sourceFailures = failures.filter((f) => f.item.action === 'create' || f.item.action === 'update');

  const result = {
    account: acct.name,
    portalId: acct.portalId,
    file: sourceFile,
    apply,
    reconcile,
    plan,
    failures,
    counts: {
      delete: plan.filter((x) => x.action === 'delete').length,
      create: plan.filter((x) => x.action === 'create').length,
      update: plan.filter((x) => x.action === 'update').length,
      unchanged: plan.filter((x) => x.action === 'unchanged').length,
    },
  };

  if (apply && sourceFailures.length) {
    const err = new Error(
      `redirects: ${sourceFailures.length} managed redirect(s) failed to apply:\n` +
        sourceFailures.map((f) => `  - ${f.message}`).join('\n'),
    );
    err.result = result;
    throw err;
  }

  return result;
}

export function renderRedirectReport(result) {
  const mode = result.apply ? 'applied' : 'dry-run';
  const lines = [];
  lines.push(`redirects ${mode}${result.reconcile ? ' (reconcile)' : ''} -> account "${result.account}" (portal ${result.portalId})`);
  lines.push(`source: ${result.file}`);
  const c = result.counts;
  lines.push(
    `summary: ${c.delete ?? 0} delete, ${c.create} create, ${c.update} update, ${c.unchanged} unchanged`,
  );
  for (const item of result.plan) {
    if (item.action === 'delete') {
      lines.push(`  [delete] ${item.current?.routePrefix} -> ${item.current?.destination} (${item.reason})`);
      continue;
    }
    const arrow = `${item.spec.routePrefix} -> ${item.spec.destination}`;
    if (item.action === 'update') {
      lines.push(`  [update] ${arrow} (was -> ${item.current?.destination})`);
    } else {
      lines.push(`  [${item.action}] ${arrow}`);
    }
  }
  if (result.failures?.length) {
    lines.push(`failures (${result.failures.length}):`);
    for (const f of result.failures) lines.push(`  - ${f.message}`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const accountName = argv.find((a) => !a.startsWith('--'));
  if (!accountName) {
    process.stderr.write('usage: node src/redirects.mjs <account> [--file <path>] [--apply]\n');
    return 2;
  }
  let file;
  let apply = false;
  let reconcile = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') apply = true;
    if (argv[i] === '--reconcile') reconcile = true;
    if (argv[i] === '--file') file = argv[++i];
  }
  try {
    const result = await syncRedirects(accountName, { file, apply, reconcile, config: opts.config }, opts.deps);
    process.stdout.write(renderRedirectReport(result) + '\n');
    return 0;
  } catch (e) {
    // A reconcile apply that fails on managed sources still carries a result with the
    // full plan/failures — surface the report before the error for diagnosis.
    if (e.result) process.stdout.write(renderRedirectReport(e.result) + '\n');
    process.stderr.write(`redirects failed: ${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
