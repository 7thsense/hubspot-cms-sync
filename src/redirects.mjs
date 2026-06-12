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

function readOnlySet(config) {
  return new Set((config?.readOnlyPortalIds?.length ? config.readOnlyPortalIds : [READ_ONLY_PORTAL]).map(String));
}

export async function syncRedirects(name, options = {}, deps = {}) {
  const {
    apply = false,
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
  const plan = planRedirects(specs, existing);

  if (apply) {
    for (const item of plan) {
      if (item.action === 'create') {
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
    }
  }

  return {
    account: acct.name,
    portalId: acct.portalId,
    file: sourceFile,
    apply,
    plan,
    counts: {
      create: plan.filter((x) => x.action === 'create').length,
      update: plan.filter((x) => x.action === 'update').length,
      unchanged: plan.filter((x) => x.action === 'unchanged').length,
    },
  };
}

export function renderRedirectReport(result) {
  const mode = result.apply ? 'applied' : 'dry-run';
  const lines = [];
  lines.push(`redirects ${mode} -> account "${result.account}" (portal ${result.portalId})`);
  lines.push(`source: ${result.file}`);
  lines.push(
    `summary: ${result.counts.create} create, ${result.counts.update} update, ${result.counts.unchanged} unchanged`,
  );
  for (const item of result.plan) {
    const arrow = `${item.spec.routePrefix} -> ${item.spec.destination}`;
    if (item.action === 'update') {
      lines.push(`  [update] ${arrow} (${item.changedFields.join(', ')})`);
    } else {
      lines.push(`  [${item.action}] ${arrow}`);
    }
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
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') apply = true;
    if (argv[i] === '--file') file = argv[++i];
  }
  try {
    const result = await syncRedirects(accountName, { file, apply, config: opts.config }, opts.deps);
    process.stdout.write(renderRedirectReport(result) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`redirects failed: ${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
