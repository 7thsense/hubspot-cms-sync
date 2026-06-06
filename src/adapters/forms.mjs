// sync/adapters/forms.mjs — HubSpot forms + their custom contact properties.
//
// Refactor of sync/forms-sync.mjs into the bidirectional-sync adapter interface,
// ADDING a pull direction so production form definitions become canonical,
// name-keyed, account-agnostic files.
//
// WHAT THIS ADAPTER OWNS (codex review: forms are render-affecting refs that
// pages/widgets/theme reference by form GUID — finding #2, #12):
//   - HubSpot marketing forms (v2 list / create / update).
//   - The custom contact PROPERTIES those forms collect (crm v3 properties),
//     synced write-scope-only (create-or-patch, converge on 409) exactly as the
//     legacy forms-sync.mjs did.
//
// CANONICAL STORE (committed to git, per-account-id-free):
//   content/forms/<form-key>.json   one file per form, keyed by a stable logical
//                                   key derived from the form NAME. Holds
//                                   { key, name, fields[] } — NO guid, NO portal id.
//   content/forms/properties.json   the custom contact properties (name/label/
//                                   fieldType), sorted by name.
//
// REGISTRY (gitignored, per-account, refs.mjs Registry):
//   On PULL  we register registry.forms[<key>] = <guid> for the SOURCE account so a
//            same-account pull->push round-trip resolves form refs back to identical
//            GUIDs.
//   On PUSH  we POPULATE registry.forms[<key>] = <target guid> after upsert so the
//            theme/pages/widgets/blog adapters (which CONSUME @form:<key> tokens via
//            refs.resolve) can resolve form references to THIS account's GUIDs.
//            We also surface any CTA guids the forms expose into registry.ctas as
//            they become available (none are emitted by the v2 forms API today, but
//            the hook is here so the dependency contract is explicit).
//
// IDENTITY: form NAME (human, account-portable) <-> logical key (slug of the name).
//   The legacy forms-sync.mjs shipped a fixed key->name table (contact/demo/...);
//   we preserve those keys for the known site forms and fall back to a deterministic
//   slug for any other form found on pull, so an arbitrary account still round-trips.
//
// PRODUCTION (portal 529456) IS READ-ONLY. This adapter never hardcodes a portal;
// the orchestrator passes `acct`. push() writes only to whatever `acct` it is given.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { hub as defaultHub } from '../lib/hub.mjs';
import { stableStringify } from '../lib/canonical.mjs';

export const name = 'forms';

// Forms have no cross-adapter dependencies at PUSH time: properties and forms are
// self-contained, and forms POPULATE the registry that OTHER adapters depend on.
export const dependsOn = [];

// ---------------------------------------------------------------------------
// Desired-state seed (carried over from sync/forms-sync.mjs). This is the known
// set of site forms + the custom contact properties they collect. It supplies:
//   - stable logical keys for the canonical filenames (key <-> name), and
//   - the fields a FRESH account should get when no canonical files exist yet.
// Once pulled, the canonical files on disk are the source of truth and override
// these defaults.
// ---------------------------------------------------------------------------

const PROPS = [
  ['topic', 'Inquiry topic', 'text'],
  ['platform', 'Marketing platform', 'text'],
  ['hubspot_hub_size', 'Marketing contacts (range)', 'text'],
  ['app_install_goal', 'App install goal', 'textarea'],
  ['challenge', 'Biggest email challenge', 'textarea'],
  ['agency', 'Agency name', 'text'],
  ['agency_website', 'Agency website', 'text'],
  ['role', 'Role', 'text'],
  ['clients', 'Number of clients', 'text'],
  ['notes', 'Notes', 'textarea'],
];

const F = (n, label, required = false, fieldType = 'text') => ({ name: n, label, fieldType, required });
const E = F('email', 'Work email', true, 'text');

// key -> { name, fields }. The key is the logical token suffix (@form:<key>).
const SEED_FORMS = {
  contact: {
    name: 'Website: Contact (general)',
    fields: [F('firstname', 'First name'), F('lastname', 'Last name'), E, F('company', 'Company'), F('topic', 'What’s this about?'), F('message', 'Message', false, 'textarea')],
  },
  demo: {
    name: 'Website: Demo / Trial request',
    fields: [F('firstname', 'First name'), F('lastname', 'Last name'), E, F('company', 'Company'), F('jobtitle', 'Job title'), F('platform', 'Marketing platform'), F('hubspot_hub_size', 'Marketing contacts'), F('challenge', 'Biggest email challenge', false, 'textarea')],
  },
  install: {
    name: 'Website: App install lead',
    fields: [F('firstname', 'First name'), F('lastname', 'Last name'), E, F('company', 'Company'), F('jobtitle', 'Job title'), F('hubspot_hub_size', 'Marketing contacts'), F('app_install_goal', 'Goal', false, 'textarea')],
  },
  partner: {
    name: 'Website: Agency Partner Program',
    fields: [F('firstname', 'First name'), F('lastname', 'Last name'), E, F('agency', 'Agency'), F('agency_website', 'Website'), F('role', 'Role'), F('platform', 'Platform'), F('clients', 'Clients'), F('notes', 'Notes', false, 'textarea')],
  },
  legal: {
    name: 'Website: Legal/Security updates opt-in',
    fields: [E],
  },
};

// name -> key, derived from the seed so pull re-uses the friendly keys for the
// known site forms.
const NAME_TO_SEED_KEY = new Map(Object.entries(SEED_FORMS).map(([k, v]) => [v.name, k]));

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested): name<->key, field canonicalization, registry pop.
// ---------------------------------------------------------------------------

/**
 * Stable, account-agnostic logical key for a form NAME. Known site forms keep
 * their friendly seed key; anything else is slugified deterministically.
 * @param {string} formName
 * @returns {string}
 */
export function formKeyForName(formName) {
  const known = NAME_TO_SEED_KEY.get(formName);
  if (known) return known;
  const slug = String(formName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'form';
}

/** Flatten a v2 form's formFieldGroups into a flat fields[]. */
function flattenFormFields(form) {
  return (form.formFieldGroups || []).flatMap((g) => g.fields || []);
}

// ---------------------------------------------------------------------------
// Behavior-loss detection (codex #8): the canonical projection keeps ONLY
// name/label/fieldType/required. A real prod form can carry far more config
// that materially changes how the form behaves and what it collects:
//
//   FIELD-LEVEL (per field, dropped by canonicalForm):
//     options / selectedOptions  - dropdown/radio/checkbox CHOICES (no choices
//                                  => the field collects nothing meaningful)
//     validation                 - regex / min / max / blockedEmailDomains
//     dependentFieldFilters      - progressive / conditional show-hide logic
//     enabled (===false)         - a disabled field still POSTed by the API
//     defaultValue / defaultValues, placeholder, description, hidden,
//     useCountryCodeSelect, isSmartField, ...
//
//   FORM-LEVEL (dropped entirely — only name+fields survive):
//     legalConsentOptions / metaData[].name==='legalConsentOptions'
//                                - GDPR / explicit-consent text + checkboxes
//     redirect / configuration.redirectUrl / inlineMessage
//                                - what happens AFTER submit (thank-you page vs
//                                  inline message) — a behavior change, not cosmetic
//     submitText / displayOptions, cssClass, notifyRecipients, followUpId, ...
//
// We do NOT try to round-trip all of this (v2 shape drift + server defaults are
// risky — design §6.3). Instead we FAIL LOUD: capture which keys were present
// but NOT modeled, attach them to the canonical file under `unsupported`, and
// emit a per-form note so the partial data is never silently presented as the
// whole truth.
// ---------------------------------------------------------------------------

// Per-field keys the canonical projection KEEPS (everything else, when present
// and non-trivial, is behavior we are NOT round-tripping).
const KEPT_FIELD_KEYS = new Set(['name', 'label', 'fieldType', 'required']);

// Field keys that, when present, ALWAYS mean lost behavior (even truthy-empty
// is meaningful: an empty options[] on a select still differs from a text field).
const BEHAVIOR_FIELD_KEYS = [
  'options',
  'selectedOptions',
  'validation',
  'dependentFieldFilters',
  'defaultValue',
  'defaultValues',
  'placeholder',
  'description',
  'enabled',
  'hidden',
  'isSmartField',
  'useCountryCodeSelect',
];

// Form-level keys that carry submit/consent/redirect behavior.
const BEHAVIOR_FORM_KEYS = [
  'legalConsentOptions',
  'redirect',
  'inlineMessage',
  'submitText',
  'configuration',
  'displayOptions',
  'cssClass',
  'notifyRecipients',
  'followUpId',
  'metaData',
];

const isMeaningful = (v) => {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'boolean') return v === true || v === false; // presence itself is signal
  return true;
};

/**
 * Inspect a raw v2 form and return the behavior the canonical projection does
 * NOT round-trip, as a stable, serializable object. Empty => fully captured.
 * @param {object} rawForm
 * @returns {{ formLevel: Record<string,unknown>, fields: Record<string,object> }|null}
 */
export function detectUnsupported(rawForm) {
  const formLevel = {};
  for (const k of BEHAVIOR_FORM_KEYS) {
    // `enabled` on a field is meaningful only when false; on the form, redirect
    // etc. are meaningful when present at all.
    if (isMeaningful(rawForm?.[k])) formLevel[k] = rawForm[k];
  }
  // The form may also carry top-level keys we don't model at all beyond the
  // known volatile ones — but we only LOUDLY flag the behavior-bearing set
  // above to avoid noise from per-account/volatile metadata.

  const fields = {};
  for (const f of flattenFormFields(rawForm)) {
    const lost = {};
    for (const k of BEHAVIOR_FIELD_KEYS) {
      if (!(k in (f || {}))) continue;
      // `enabled:true` and `hidden:false` are the harmless defaults; only flag
      // the non-default direction.
      if (k === 'enabled' && f[k] !== false) continue;
      if (k === 'hidden' && f[k] !== true) continue;
      if (k === 'isSmartField' && f[k] !== true) continue;
      if (k === 'useCountryCodeSelect' && f[k] !== true) continue;
      if (isMeaningful(f[k])) lost[k] = f[k];
    }
    // Any OTHER unknown field key (not kept, not a known volatile) is also a
    // signal we're dropping something — capture its presence by key.
    for (const k of Object.keys(f || {})) {
      if (KEPT_FIELD_KEYS.has(k)) continue;
      if (BEHAVIOR_FIELD_KEYS.includes(k)) continue;
      if (k === 'fieldType') continue;
      // record only that the key existed; value may be volatile/account-specific
      if (isMeaningful(f[k]) && !(k in lost)) lost[`_${k}`] = true;
    }
    if (Object.keys(lost).length > 0) fields[f.name || '(unnamed)'] = lost;
  }

  if (Object.keys(formLevel).length === 0 && Object.keys(fields).length === 0) {
    return null;
  }
  return { formLevel, fields };
}

/** One-line human summary of what detectUnsupported found, for the loud note. */
export function summarizeUnsupported(unsupported) {
  if (!unsupported) return '';
  const parts = [];
  const fl = Object.keys(unsupported.formLevel || {});
  if (fl.length) parts.push(`form-level [${fl.sort().join(', ')}]`);
  const fieldNames = Object.keys(unsupported.fields || {});
  if (fieldNames.length) {
    const detail = fieldNames
      .sort()
      .map((n) => `${n}:{${Object.keys(unsupported.fields[n]).sort().join(',')}}`)
      .join(' ');
    parts.push(`field-level ${detail}`);
  }
  return parts.join('; ');
}

/**
 * Project a raw v2 form into its canonical, account-agnostic definition.
 * Strips guid, portalId, and every per-account/volatile field — keeps only the
 * portable contract: logical key, display name, and the field shape that drives
 * both validation and the styled UX (name/label/fieldType/required).
 *
 * Behavior the projection does NOT model (options/consent/validation/redirect/
 * conditional logic) is detected and attached under `unsupported` so the file
 * is HONEST about being partial — it is never silently presented as the whole
 * form. `unsupported` is omitted entirely when the form is fully captured.
 * @param {object} rawForm a v2 form object (with guid, portalId, formFieldGroups)
 * @returns {{ key: string, name: string, fields: Array, unsupported?: object }}
 */
export function canonicalForm(rawForm) {
  const fields = flattenFormFields(rawForm).map((f) => ({
    name: f.name,
    label: f.label ?? '',
    fieldType: f.fieldType ?? 'text',
    required: !!f.required,
  }));
  const out = { key: formKeyForName(rawForm.name), name: rawForm.name, fields };
  const unsupported = detectUnsupported(rawForm);
  if (unsupported) out.unsupported = unsupported;
  return out;
}

/** Project raw crm v3 contact properties down to the portable definition. */
export function canonicalProperties(rawProps) {
  return (rawProps || [])
    .map((p) => ({ name: p.name, label: p.label ?? '', fieldType: p.fieldType ?? 'text' }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * POPULATE the per-account registry from upserted (or pulled) forms so other
 * adapters can resolve @form:<key> tokens. Records registry.forms[key] = guid for
 * every form that has a guid, and (when present) any CTA guids the form exposes
 * into registry.ctas. Mutates and returns the registry.
 * @param {object} registry refs.mjs Registry for the current account
 * @param {Array<{key:string, guid?:string, ctas?:Record<string,string>}>} forms
 * @returns {object} the same registry
 */
export function populateRegistry(registry, forms) {
  for (const f of forms || []) {
    if (f.guid) {
      registry.forms[f.key] = String(f.guid);
      delete registry.__rev_forms; // invalidate refs.mjs memoized reverse index
    }
    if (f.ctas && typeof f.ctas === 'object') {
      for (const [ctaKey, guid] of Object.entries(f.ctas)) {
        if (guid) {
          registry.ctas[ctaKey] = String(guid);
          delete registry.__rev_ctas;
        }
      }
    }
  }
  return registry;
}

// Stable signature for "did the fields drift?" — name + required, in order.
const sigFields = (fields) => JSON.stringify((fields || []).map((f) => [f.name, !!f.required]));

// ---------------------------------------------------------------------------
// Disk layer for the canonical content/forms tree.
// ---------------------------------------------------------------------------

function formsDir(contentDir) {
  return join(contentDir, 'forms');
}

/** Read every content/forms/<key>.json (excluding properties.json) -> [{key,name,fields}]. */
export function readCanonicalForms(contentDir) {
  const dir = formsDir(contentDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    if (file === 'properties.json' || file === 'guids.json') continue;
    const def = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    out.push({ key: def.key, name: def.name, fields: def.fields || [] });
  }
  return out;
}

function readCanonicalProperties(contentDir) {
  const file = join(formsDir(contentDir), 'properties.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// pull(acct, { contentDir, registry }) -> { pulled, notes }
//   GET v2 forms + GET crm v3 contact properties -> canonical files.
//   Register registry.forms[key] = guid for the SOURCE account (round-trip).
// ---------------------------------------------------------------------------
export async function pull(acct, ctx) {
  const { contentDir, registry } = ctx;
  const hub = ctx.hub || defaultHub;
  const notes = [];

  // --- forms (v2 list) ---
  const res = await hub(acct, 'GET', '/forms/v2/forms?limit=300');
  if (!res.ok) {
    throw new Error(`forms pull: GET /forms/v2/forms -> ${res.status}: ${res.json?.message || ''}`);
  }
  const rawForms = Array.isArray(res.json) ? res.json : res.json.objects || [];

  const dir = formsDir(contentDir);
  mkdirSync(dir, { recursive: true });

  let pulled = 0;
  // Guard against the key-collision DATA-LOSS hole: two forms whose names slugify
  // to the same key would silently overwrite each other on disk AND in
  // registry.forms[key]. Disambiguate the second+ with a numeric suffix so NO form
  // is ever lost, and emit a loud note so the collision is visible.
  const usedKeys = new Set();
  for (const raw of rawForms) {
    const canon = canonicalForm(raw);
    if (usedKeys.has(canon.key)) {
      let n = 2;
      while (usedKeys.has(`${canon.key}-${n}`)) n += 1;
      const disambiguated = `${canon.key}-${n}`;
      notes.push(
        `⚠ form name collision: "${raw.name}" slug clashes with an earlier form — stored as "${disambiguated}" (rename one to disambiguate)`,
      );
      canon.key = disambiguated;
    }
    usedKeys.add(canon.key);
    writeFileSync(join(dir, `${canon.key}.json`), stableStringify(canon));
    // FAIL LOUD on behavior loss (codex #8): if the raw prod form carried
    // options/consent/validation/redirect/conditional logic that the canonical
    // projection does NOT round-trip, say so explicitly — naming the form and
    // exactly which config is captured-but-not-round-tripped — so this partial
    // file is never silently mistaken for the live truth. The dropped config is
    // also preserved verbatim under `unsupported` in the file.
    if (canon.unsupported) {
      notes.push(
        `⚠ form "${raw.name}" (${canon.key}) carries config NOT round-tripped: ` +
          `${summarizeUnsupported(canon.unsupported)} — captured under .unsupported (read-only); ` +
          'push does NOT recreate it. The canonical file is a PARTIAL view of the live form.',
      );
    }
    // Register the SOURCE account's guid under the same logical key so a
    // same-account pull->push converges (the guid never enters the canonical file).
    if (raw.guid) {
      registry.forms[canon.key] = String(raw.guid);
      delete registry.__rev_forms;
    }
    pulled += 1;
  }
  notes.push(`pulled ${pulled} form(s)`);

  // --- custom contact properties (crm v3) ---
  const propsRes = await hub(acct, 'GET', '/crm/v3/properties/contacts?archived=false');
  if (propsRes.ok) {
    const canonProps = canonicalProperties(propsRes.json.results || []);
    // Keep only the custom properties this site manages (others are HubSpot
    // defaults / unrelated; committing all of them would be noise).
    const managed = new Set(PROPS.map(([n]) => n));
    const filtered = canonProps.filter((p) => managed.has(p.name));
    writeFileSync(join(dir, 'properties.json'), stableStringify(filtered));
    notes.push(`pulled ${filtered.length} managed propert(ies)`);
  } else {
    // No property-read scope: seed the canonical file from the desired state so a
    // subsequent push still has a source of truth.
    //
    // FAIL LOUD (codex #8): this seeded file is the repo's DESIRED state, NOT a
    // read of what the live account actually has. We could not read prod's real
    // property config (labels/types/options may differ, and properties we don't
    // manage are invisible here), so we must warn that properties.json is NOT
    // verified against the live truth — committing it as canonical risks
    // overwriting real prod property config on a later push.
    const seeded = canonicalProperties(PROPS.map(([n, label, fieldType]) => ({ name: n, label, fieldType })));
    writeFileSync(join(dir, 'properties.json'), stableStringify(seeded));
    notes.push(
      `⚠ NO property-read scope (GET /crm/v3/properties/contacts -> ${propsRes.status}) — ` +
        `properties.json was SEEDED from desired state, NOT read from the live account. ` +
        `This file is DESIRED-STATE-ONLY: it may diverge from prod's real property ` +
        `labels/types/options and does NOT reflect properties this site doesn't manage. ` +
        `Do NOT treat it as the live truth; grant crm.schemas.contacts.read and re-pull to verify.`,
    );
  }

  return { pulled, notes };
}

// ---------------------------------------------------------------------------
// push(acct, { contentDir, registry }) -> { pushed, notes }
//   Properties first (create-or-patch, write-scope-only convergence on 409),
//   then forms (upsert by NAME), then RECORD registry.forms[key] = target guid so
//   downstream adapters can resolve @form:<key>.
// ---------------------------------------------------------------------------
export async function push(acct, ctx) {
  const { contentDir, registry } = ctx;
  const hub = ctx.hub || defaultHub;
  const notes = [];

  // Source of truth: canonical files if present, else the seed (fresh account).
  let forms = readCanonicalForms(contentDir);
  if (forms.length === 0) {
    forms = Object.entries(SEED_FORMS).map(([key, v]) => ({ key, name: v.name, fields: v.fields }));
    notes.push('no canonical forms on disk — pushing seed defaults');
  }
  let props = readCanonicalProperties(contentDir);
  if (!props) {
    props = canonicalProperties(PROPS.map(([n, label, fieldType]) => ({ name: n, label, fieldType })));
  }

  await pushProperties(acct, hub, props, notes);

  // --- upsert forms by name ---
  const listRes = await hub(acct, 'GET', '/forms/v2/forms?limit=300');
  if (!listRes.ok) {
    throw new Error(`forms push: GET /forms/v2/forms -> ${listRes.status}: ${listRes.json?.message || ''}`);
  }
  const existing = new Map(
    (Array.isArray(listRes.json) ? listRes.json : listRes.json.objects || []).map((f) => [f.name, f]),
  );

  const upserted = [];
  let pushed = 0;
  for (const def of forms) {
    const cur = existing.get(def.name);
    if (!cur) {
      const r = await hub(acct, 'POST', '/forms/v2/forms', {
        name: def.name,
        formFieldGroups: [{ fields: def.fields }],
      });
      if (r.ok && r.json.guid) {
        upserted.push({ key: def.key, guid: r.json.guid });
        notes.push(`form + ${def.key} (${r.json.guid})`);
        pushed += 1;
      } else {
        throw new Error(`forms push: create ${def.key} -> ${r.status}: ${r.json?.message || ''}`);
      }
      continue;
    }
    upserted.push({ key: def.key, guid: cur.guid });
    if (sigFields(flattenFormFields(cur)) === sigFields(def.fields)) {
      notes.push(`form = ${def.key} (${cur.guid})`);
      continue;
    }
    const r = await hub(acct, 'PUT', `/forms/v2/forms/${cur.guid}`, {
      ...cur,
      formFieldGroups: [{ fields: def.fields }],
    });
    if (!r.ok) throw new Error(`forms push: update ${def.key} -> ${r.status}: ${r.json?.message || ''}`);
    notes.push(`form ~ ${def.key} (${cur.guid}, fields synced)`);
    pushed += 1;
  }

  // RECORD target GUIDs into the registry so theme/pages/widgets/blog push can
  // resolve @form:<key> (and any CTA refs) to THIS account.
  populateRegistry(registry, upserted);
  notes.push(`registry.forms populated with ${upserted.length} key(s)`);

  return { pushed, notes };
}

// Properties: create-or-patch, write-scope-only. If a read returns the schema we
// diff; otherwise we create and converge on 409 (matches legacy forms-sync.mjs).
async function pushProperties(acct, hub, props, notes) {
  const list = await hub(acct, 'GET', '/crm/v3/properties/contacts?archived=false');
  const have = list.ok ? new Map((list.json.results || []).map((p) => [p.name, p])) : null;
  if (!have) notes.push('no property-read scope — using create-or-patch');

  for (const { name: pname, label, fieldType } of props) {
    const body = { label, fieldType };
    const cur = have && have.get(pname);

    if (have && !cur) {
      const r = await hub(acct, 'POST', '/crm/v3/properties/contacts', {
        name: pname, type: 'string', groupName: 'contactinformation', ...body,
      });
      notes.push(r.ok ? `prop + ${pname}` : `prop x ${pname}: ${r.json?.message || r.status}`);
      continue;
    }
    if (have && cur && cur.label === label && cur.fieldType === fieldType) {
      notes.push(`prop = ${pname}`);
      continue;
    }
    if (have && cur) {
      const r = await hub(acct, 'PATCH', `/crm/v3/properties/contacts/${pname}`, body);
      notes.push(r.ok ? `prop ~ ${pname}` : `prop x ${pname}: ${r.json?.message || r.status}`);
      continue;
    }
    // No read scope: create, converge via patch on conflict.
    const c = await hub(acct, 'POST', '/crm/v3/properties/contacts', {
      name: pname, type: 'string', groupName: 'contactinformation', ...body,
    });
    if (c.ok) { notes.push(`prop + ${pname}`); continue; }
    if (c.status === 409 || /already exists/i.test(c.json?.message || '')) {
      const u = await hub(acct, 'PATCH', `/crm/v3/properties/contacts/${pname}`, body);
      notes.push(u.ok ? `prop = ${pname} (exists, synced)` : `prop x ${pname}: ${u.json?.message || u.status}`);
    } else {
      notes.push(`prop x ${pname}: ${c.json?.message || c.status}`);
    }
  }
}

export default { name, dependsOn, pull, push };
