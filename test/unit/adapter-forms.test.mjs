// Unit tests for sync/adapters/forms.mjs — pure + mocked hub, NO real network.
//   node --test test/unit/adapter-forms.test.mjs
//
// Strategy: inject ctx.hub (a recording mock returning canned responses) and use a
// temp contentDir on a fresh fs. We assert:
//   - name-keyed canonicalization strips guid/portal and keeps the field shape,
//   - pull writes content/forms/<key>.json + properties.json and registers SOURCE
//     guids under the friendly key,
//   - push upserts properties + forms and POPULATES registry.forms[key]=target guid,
//   - the canonicalization + registry population are idempotent (pull->push->pull
//     converges on the same name-keyed identity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  name,
  dependsOn,
  formKeyForName,
  canonicalForm,
  canonicalProperties,
  populateRegistry,
  readCanonicalForms,
  detectUnsupported,
  summarizeUnsupported,
  pull,
  push,
} from '../../src/adapters/forms.mjs';
import { emptyRegistry } from '../../src/lib/refs.mjs';

const ACCT = { name: 'dev', portalId: '246389711', key: 'pat-test' };

// A raw v2 form as the API returns it: guid + portalId + nested formFieldGroups.
function rawForm(name, guid, fields) {
  return {
    guid,
    name,
    portalId: 529456,
    formFieldGroups: [{ fields }],
  };
}

const PROD_FORMS = [
  rawForm('Website: Contact (general)', 'aaaaaaaa-0000-0000-0000-000000000001', [
    { name: 'firstname', label: 'First name', fieldType: 'text', required: false },
    { name: 'email', label: 'Work email', fieldType: 'text', required: true },
  ]),
  rawForm('Some Other Form!!', 'bbbbbbbb-0000-0000-0000-000000000002', [
    { name: 'email', label: 'Email', fieldType: 'text', required: true },
  ]),
];

const PROD_PROPS = {
  results: [
    { name: 'topic', label: 'Inquiry topic', fieldType: 'text' },
    { name: 'role', label: 'Role', fieldType: 'text' },
    { name: 'unrelated_default', label: 'Not ours', fieldType: 'text' },
  ],
};

// Recording mock hub. `routes` maps "METHOD path-or-prefix" -> response object.
function mockHub(routes, calls = []) {
  return async (acct, method, path, body) => {
    calls.push({ method, path, body });
    for (const [pattern, resp] of routes) {
      const [m, p] = pattern.split(' ');
      if (m === method && (path === p || path.startsWith(p))) {
        return typeof resp === 'function' ? resp({ method, path, body }) : resp;
      }
    }
    return { ok: false, status: 404, json: { message: `no mock for ${method} ${path}` } };
  };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'forms-sync-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// Pure: name-keyed canonicalization
// =============================================================================

test('adapter exposes name + empty dependsOn', () => {
  assert.equal(name, 'forms');
  assert.deepEqual(dependsOn, []);
});

test('formKeyForName uses friendly key for known site forms', () => {
  assert.equal(formKeyForName('Website: Contact (general)'), 'contact');
  assert.equal(formKeyForName('Website: Demo / Trial request'), 'demo');
});

test('formKeyForName slugifies unknown forms deterministically', () => {
  assert.equal(formKeyForName('Some Other Form!!'), 'some-other-form');
  assert.equal(formKeyForName('  Lé  Form  '), 'l-form');
  assert.equal(formKeyForName(''), 'form');
});

test('canonicalForm strips guid + portalId and keeps only the field contract', () => {
  const canon = canonicalForm(PROD_FORMS[0]);
  assert.equal(canon.key, 'contact');
  assert.equal(canon.name, 'Website: Contact (general)');
  assert.deepEqual(canon.fields, [
    { name: 'firstname', label: 'First name', fieldType: 'text', required: false },
    { name: 'email', label: 'Work email', fieldType: 'text', required: true },
  ]);
  // No per-account identity leaks into the canonical object.
  const s = JSON.stringify(canon);
  assert.ok(!s.includes('aaaaaaaa-0000'), 'guid must not appear');
  assert.ok(!s.includes('529456'), 'portal id must not appear');
});

// =============================================================================
// Pure: behavior-loss detection (codex #8) — what is NOT round-tripped
// =============================================================================

// A richer raw form carrying field-level + form-level behavior the canonical
// projection (name/label/fieldType/required) does NOT model.
function richRawForm() {
  return {
    guid: 'eeeeeeee-0000-0000-0000-000000000009',
    name: 'Website: Rich Form',
    portalId: 529456,
    // form-level behavior: where it redirects + GDPR consent.
    redirect: 'https://example.com/thanks',
    inlineMessage: '<p>Thanks!</p>',
    legalConsentOptions: { type: 'explicit_consent_to_process', communicationConsentText: 'I agree' },
    configuration: { redirectUrl: 'https://example.com/thanks' },
    formFieldGroups: [
      {
        fields: [
          // plain field — fully captured, contributes nothing to `unsupported`
          { name: 'email', label: 'Work email', fieldType: 'text', required: true },
          // dropdown with CHOICES + conditional logic + validation — all dropped
          {
            name: 'platform',
            label: 'Platform',
            fieldType: 'select',
            required: false,
            options: [
              { label: 'HubSpot', value: 'hubspot' },
              { label: 'Marketo', value: 'marketo' },
            ],
            validation: { name: 'platform', useDefaultBlockList: true },
            dependentFieldFilters: [{ filters: [{ strValue: 'hubspot' }] }],
            defaultValue: 'hubspot',
            placeholder: 'Pick one',
            enabled: false,
          },
        ],
      },
    ],
  };
}

test('detectUnsupported flags dropped form-level + field-level behavior', () => {
  const u = detectUnsupported(richRawForm());
  assert.ok(u, 'rich form has unsupported config');
  // form-level: redirect / inlineMessage / legalConsentOptions / configuration
  assert.ok('redirect' in u.formLevel);
  assert.ok('legalConsentOptions' in u.formLevel);
  assert.ok('inlineMessage' in u.formLevel);
  assert.ok('configuration' in u.formLevel);
  // field-level: only the rich 'platform' field, NOT the plain 'email' field
  assert.deepEqual(Object.keys(u.fields), ['platform']);
  assert.ok('email' in u.fields === false, 'fully-captured field not flagged');
  const lost = u.fields.platform;
  assert.ok('options' in lost, 'dropdown choices flagged as lost');
  assert.ok('validation' in lost);
  assert.ok('dependentFieldFilters' in lost, 'conditional logic flagged');
  assert.ok('defaultValue' in lost);
  assert.ok('placeholder' in lost);
  assert.ok('enabled' in lost, 'enabled:false flagged');
});

test('detectUnsupported returns null for a fully-captured plain form', () => {
  // PROD_FORMS[0] is name/label/fieldType/required only — nothing lost.
  assert.equal(detectUnsupported(PROD_FORMS[0]), null);
});

test('detectUnsupported ignores harmless defaults (enabled:true, hidden:false)', () => {
  const raw = rawForm('Plain', 'g', [
    { name: 'email', label: 'E', fieldType: 'text', required: true, enabled: true, hidden: false },
  ]);
  assert.equal(detectUnsupported(raw), null, 'default-direction flags are not behavior loss');
});

test('detectUnsupported flags an unknown field key it does not model', () => {
  const raw = rawForm('Has Unknown', 'g', [
    { name: 'email', fieldType: 'text', required: true, someNewHubspotKey: 'value' },
  ]);
  const u = detectUnsupported(raw);
  assert.ok(u && u.fields.email && u.fields.email._someNewHubspotKey === true);
});

test('summarizeUnsupported produces a stable human one-liner', () => {
  const u = detectUnsupported(richRawForm());
  const s = summarizeUnsupported(u);
  assert.ok(s.includes('form-level'));
  assert.ok(s.includes('redirect'));
  assert.ok(s.includes('field-level'));
  assert.ok(s.includes('platform'));
  assert.ok(s.includes('options'));
});

test('canonicalForm attaches .unsupported for a rich form, omits it for a plain one', () => {
  const rich = canonicalForm(richRawForm());
  assert.ok(rich.unsupported, 'rich form keeps an unsupported block');
  // the canonical fields themselves stay thin (only the 4 portable keys)
  assert.deepEqual(Object.keys(rich.fields[1]).sort(), ['fieldType', 'label', 'name', 'required']);
  const plain = canonicalForm(PROD_FORMS[0]);
  assert.ok(!('unsupported' in plain), 'plain form has NO unsupported block');
});

test('canonicalProperties projects + sorts by name', () => {
  const out = canonicalProperties(PROD_PROPS.results);
  assert.deepEqual(out.map((p) => p.name), ['role', 'topic', 'unrelated_default']);
  assert.deepEqual(out[0], { name: 'role', label: 'Role', fieldType: 'text' });
});

// =============================================================================
// Pure: registry population (the cross-adapter contract)
// =============================================================================

test('populateRegistry records forms[key]=guid and invalidates reverse index', () => {
  const reg = emptyRegistry('246389711');
  // prime a stale reverse-index cache to prove it gets invalidated
  reg.forms['old'] = 'zzzz';
  // eslint-disable-next-line no-unused-expressions
  Object.defineProperty(reg, '__rev_forms', { value: { zzzz: 'old' }, enumerable: false, configurable: true });

  populateRegistry(reg, [
    { key: 'contact', guid: '1111' },
    { key: 'demo', guid: '2222', ctas: { 'book-demo': 'cta-guid-1' } },
    { key: 'skip', guid: undefined },
  ]);

  assert.equal(reg.forms.contact, '1111');
  assert.equal(reg.forms.demo, '2222');
  assert.ok(!('skip' in reg.forms), 'guid-less forms are not registered');
  assert.equal(reg.ctas['book-demo'], 'cta-guid-1');
  assert.equal(reg.__rev_forms, undefined, 'stale reverse index invalidated');
});

// =============================================================================
// pull — mocked hub + temp dir
// =============================================================================

test('pull writes name-keyed canonical files + properties, registers source guids', async () => {
  await withDir(async (dir) => {
    const registry = emptyRegistry('529456');
    const calls = [];
    const hub = mockHub(
      [
        ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
        ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
      ],
      calls,
    );

    const res = await pull(ACCT, { contentDir: dir, registry, hub });
    assert.equal(res.pulled, 2);

    // files exist, keyed by NAME-derived key
    assert.ok(existsSync(join(dir, 'forms', 'contact.json')));
    assert.ok(existsSync(join(dir, 'forms', 'some-other-form.json')));
    assert.ok(existsSync(join(dir, 'forms', 'properties.json')));

    const contact = JSON.parse(readFileSync(join(dir, 'forms', 'contact.json'), 'utf8'));
    assert.equal(contact.key, 'contact');
    assert.ok(!JSON.stringify(contact).includes('aaaaaaaa-0000'), 'no guid in file');

    // SOURCE guids registered under the friendly key for round-trip
    assert.equal(registry.forms.contact, 'aaaaaaaa-0000-0000-0000-000000000001');
    assert.equal(registry.forms['some-other-form'], 'bbbbbbbb-0000-0000-0000-000000000002');

    // properties.json keeps only managed props (drops unrelated_default)
    const props = JSON.parse(readFileSync(join(dir, 'forms', 'properties.json'), 'utf8'));
    assert.deepEqual(props.map((p) => p.name), ['role', 'topic']);
  });
});

test('pull emits a LOUD not-round-tripped warning + writes .unsupported when prod form carries dropped behavior', async () => {
  await withDir(async (dir) => {
    const registry = emptyRegistry('529456');
    const hub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: [richRawForm()] }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);

    const res = await pull(ACCT, { contentDir: dir, registry, hub });
    assert.equal(res.pulled, 1);

    // A loud per-form note names the form, key, and what is NOT round-tripped.
    const lossNotes = res.notes.filter((n) => n.includes('NOT round-tripped'));
    assert.equal(lossNotes.length, 1, 'exactly one behavior-loss note for the rich form');
    assert.ok(lossNotes[0].includes('⚠'), 'note is visibly loud');
    assert.ok(lossNotes[0].includes('Website: Rich Form'), 'note names the form');
    assert.ok(lossNotes[0].includes('redirect'), 'note names dropped form-level config');
    assert.ok(lossNotes[0].includes('options'), 'note names dropped field-level config');
    assert.ok(lossNotes[0].includes('PARTIAL'), 'note warns the file is partial');

    // The dropped config is preserved verbatim under `unsupported` on disk so it
    // is captured (not silently discarded), but the modeled fields stay thin.
    const file = JSON.parse(readFileSync(join(dir, 'forms', 'website-rich-form.json'), 'utf8'));
    assert.ok(file.unsupported, '.unsupported block written to disk');
    assert.ok('redirect' in file.unsupported.formLevel);
    assert.ok('platform' in file.unsupported.fields);
    assert.deepEqual(file.fields.map((f) => f.name), ['email', 'platform']);

    // push must NOT try to recreate unsupported config: readCanonicalForms drops it.
    const forPush = readCanonicalForms(dir);
    const richDef = forPush.find((f) => f.key === 'website-rich-form');
    assert.ok(richDef && !('unsupported' in richDef), 'push input ignores .unsupported');
  });
});

test('pull emits NO behavior-loss note when every form is fully captured', async () => {
  await withDir(async (dir) => {
    const registry = emptyRegistry('529456');
    const hub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    const res = await pull(ACCT, { contentDir: dir, registry, hub });
    const lossNotes = res.notes.filter((n) => n.includes('NOT round-tripped'));
    assert.equal(lossNotes.length, 0, 'plain forms produce no behavior-loss note');
    const file = JSON.parse(readFileSync(join(dir, 'forms', 'contact.json'), 'utf8'));
    assert.ok(!('unsupported' in file), 'no .unsupported block on a fully-captured form');
  });
});

test('pull LOUDLY warns properties.json is DESIRED-STATE-ONLY when read scope is missing', async () => {
  await withDir(async (dir) => {
    const registry = emptyRegistry('529456');
    // properties read returns 403 (no crm.schemas.contacts.read scope).
    const hub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: false, status: 403, json: { message: 'missing scope' } }],
    ]);

    const res = await pull(ACCT, { contentDir: dir, registry, hub });

    // A loud note explicitly warns the seeded file is NOT the live truth.
    const seededNotes = res.notes.filter((n) => n.includes('DESIRED-STATE-ONLY'));
    assert.equal(seededNotes.length, 1, 'exactly one seeded-properties warning');
    assert.ok(seededNotes[0].includes('⚠'), 'warning is visibly loud');
    assert.ok(seededNotes[0].includes('NO property-read scope'), 'names the missing scope');
    assert.ok(seededNotes[0].includes('403'), 'includes the failing status');
    assert.ok(seededNotes[0].includes('SEEDED'), 'says the file was seeded');
    assert.ok(
      seededNotes[0].includes('Do NOT treat it as the live truth'),
      'explicitly warns against trusting it',
    );

    // properties.json still exists (seeded) so a later push has a source of truth.
    assert.ok(existsSync(join(dir, 'forms', 'properties.json')));
  });
});

test('pull disambiguates two forms whose names slugify to the SAME key — NO form lost', async () => {
  await withDir(async (dir) => {
    const registry = emptyRegistry('529456');
    // Two distinct forms whose names both slugify to 'some-other-form'.
    const collidingForms = [
      rawForm('Some Other Form!!', 'cccccccc-0000-0000-0000-000000000001', [
        { name: 'email', label: 'Email', fieldType: 'text', required: true },
      ]),
      rawForm('Some   Other   Form???', 'dddddddd-0000-0000-0000-000000000002', [
        { name: 'phone', label: 'Phone', fieldType: 'text', required: false },
      ]),
    ];
    const hub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: collidingForms }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);

    const res = await pull(ACCT, { contentDir: dir, registry, hub });

    // Every form is accounted for — none silently overwritten.
    assert.equal(res.pulled, 2, 'both colliding forms counted');

    // BOTH written to DISTINCT files: the 2nd gets a numeric suffix.
    assert.ok(existsSync(join(dir, 'forms', 'some-other-form.json')), 'first form file written');
    assert.ok(existsSync(join(dir, 'forms', 'some-other-form-2.json')), 'second form file disambiguated');

    // The two files hold the two DIFFERENT forms (no overwrite/data loss).
    const first = JSON.parse(readFileSync(join(dir, 'forms', 'some-other-form.json'), 'utf8'));
    const second = JSON.parse(readFileSync(join(dir, 'forms', 'some-other-form-2.json'), 'utf8'));
    assert.equal(first.key, 'some-other-form');
    assert.equal(second.key, 'some-other-form-2');
    assert.deepEqual(first.fields.map((f) => f.name), ['email']);
    assert.deepEqual(second.fields.map((f) => f.name), ['phone']);

    // BOTH registered under DISTINCT keys -> distinct source guids.
    assert.equal(registry.forms['some-other-form'], 'cccccccc-0000-0000-0000-000000000001');
    assert.equal(registry.forms['some-other-form-2'], 'dddddddd-0000-0000-0000-000000000002');

    // A loud collision note is emitted naming the clashing form + chosen key.
    const collisionNotes = res.notes.filter((n) => n.includes('form name collision'));
    assert.equal(collisionNotes.length, 1, 'exactly one collision note');
    assert.ok(collisionNotes[0].includes('Some   Other   Form???'), 'note names the colliding form');
    assert.ok(collisionNotes[0].includes('some-other-form-2'), 'note names the disambiguated key');
  });
});

test('pull emits NO collision note when keys do not clash', async () => {
  await withDir(async (dir) => {
    const registry = emptyRegistry('529456');
    // PROD_FORMS slugify to two distinct keys: 'contact' and 'some-other-form'.
    const hub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);

    const res = await pull(ACCT, { contentDir: dir, registry, hub });
    assert.equal(res.pulled, 2);

    // Keys are unchanged — no numeric suffix applied to either file.
    assert.ok(existsSync(join(dir, 'forms', 'contact.json')));
    assert.ok(existsSync(join(dir, 'forms', 'some-other-form.json')));
    assert.ok(!existsSync(join(dir, 'forms', 'some-other-form-2.json')), 'no disambiguation file created');
    assert.ok(!existsSync(join(dir, 'forms', 'contact-2.json')), 'no disambiguation file created');

    // No collision note in the absence of a clash.
    const collisionNotes = res.notes.filter((n) => n.includes('form name collision'));
    assert.equal(collisionNotes.length, 0, 'no collision note when keys are distinct');
  });
});

// =============================================================================
// push — mocked hub, populates registry; idempotency (no drift => no writes)
// =============================================================================

test('push upserts forms by name and populates registry.forms[key]=target guid', async () => {
  await withDir(async (dir) => {
    // First pull from "prod" into the canonical tree.
    const srcReg = emptyRegistry('529456');
    const pullHub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: srcReg, hub: pullHub });

    // Now push into a DIFFERENT (dev) account where forms DON'T exist yet.
    const tgtReg = emptyRegistry('246389711');
    const calls = [];
    let createdGuid = 0;
    const pushHub = mockHub(
      [
        // properties: write-scope-only path (read fails)
        ['GET /crm/v3/properties/contacts', { ok: false, status: 403, json: {} }],
        ['POST /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
        // forms list: empty on target
        ['GET /forms/v2/forms', { ok: true, status: 200, json: [] }],
        ['POST /forms/v2/forms', () => {
          createdGuid += 1;
          return { ok: true, status: 200, json: { guid: `dev-guid-${createdGuid}` } };
        }],
      ],
      calls,
    );

    const res = await push(ACCT, { contentDir: dir, registry: tgtReg, hub: pushHub });
    assert.ok(res.pushed >= 2, 'both forms created');

    // registry now maps the SAME logical keys to the TARGET account's guids
    assert.equal(tgtReg.forms.contact, 'dev-guid-1');
    assert.equal(tgtReg.forms['some-other-form'], 'dev-guid-2');

    // never targeted prod / never hardcoded a portal: all calls used ACCT only
    const formCreates = calls.filter((c) => c.method === 'POST' && c.path === '/forms/v2/forms');
    assert.equal(formCreates.length, 2);
  });
});

test('push is idempotent: unchanged forms are not re-written', async () => {
  await withDir(async (dir) => {
    const srcReg = emptyRegistry('529456');
    const pullHub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: srcReg, hub: pullHub });

    // Target already HAS identical forms (same names + same field name/required sig).
    const tgtReg = emptyRegistry('246389711');
    const calls = [];
    const pushHub = mockHub(
      [
        ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: { results: [] } }],
        ['POST /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
        ['GET /forms/v2/forms', {
          ok: true, status: 200,
          json: [
            rawForm('Website: Contact (general)', 'dev-c', [
              { name: 'firstname', required: false }, { name: 'email', required: true },
            ]),
            rawForm('Some Other Form!!', 'dev-o', [{ name: 'email', required: true }]),
          ],
        }],
      ],
      calls,
    );

    const res = await push(ACCT, { contentDir: dir, registry: tgtReg, hub: pushHub });
    // No create/update form writes happened (fields converged).
    const formWrites = calls.filter(
      (c) => (c.method === 'POST' || c.method === 'PUT') && c.path.startsWith('/forms/v2/forms'),
    );
    assert.equal(formWrites.length, 0, 'no form writes when nothing drifted');
    // ...but the registry is still populated from the EXISTING target guids.
    assert.equal(tgtReg.forms.contact, 'dev-c');
    assert.equal(tgtReg.forms['some-other-form'], 'dev-o');
    assert.equal(res.pushed, 0);
  });
});

test('push does NOT duplicate a form that already exists on target by name', async () => {
  await withDir(async (dir) => {
    // Pull prod forms into the canonical tree.
    const srcReg = emptyRegistry('529456');
    const pullHub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: srcReg, hub: pullHub });

    // Target already has BOTH forms by name, but with DRIFTED fields so the upsert
    // takes the PUT (update) path rather than the no-op path. The key invariant:
    // an existing name => update-in-place, NEVER a second POST create.
    const tgtReg = emptyRegistry('246389711');
    const calls = [];
    const pushHub = mockHub(
      [
        ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: { results: [] } }],
        ['POST /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
        ['GET /forms/v2/forms', {
          ok: true, status: 200,
          json: [
            // same name, but a DIFFERENT field signature (missing 'email') => drift
            rawForm('Website: Contact (general)', 'dev-c', [{ name: 'firstname', required: false }]),
            rawForm('Some Other Form!!', 'dev-o', [{ name: 'phone', required: false }]),
          ],
        }],
        ['PUT /forms/v2/forms', { ok: true, status: 200, json: {} }],
        // A POST here would mean a DUPLICATE was created — fail loudly if hit.
        ['POST /forms/v2/forms', () => { throw new Error('unexpected POST create — duplicate form!'); }],
      ],
      calls,
    );

    const res = await push(ACCT, { contentDir: dir, registry: tgtReg, hub: pushHub });

    const creates = calls.filter((c) => c.method === 'POST' && c.path === '/forms/v2/forms');
    const updates = calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/forms/v2/forms/'));
    assert.equal(creates.length, 0, 'no form was created when the name already existed');
    assert.equal(updates.length, 2, 'both existing forms were updated in place');
    // updates target the EXISTING guids, not new ones
    assert.ok(updates.some((c) => c.path === '/forms/v2/forms/dev-c'));
    assert.ok(updates.some((c) => c.path === '/forms/v2/forms/dev-o'));
    // registry maps logical keys to the PRE-EXISTING target guids (no churn)
    assert.equal(tgtReg.forms.contact, 'dev-c');
    assert.equal(tgtReg.forms['some-other-form'], 'dev-o');
    assert.equal(res.pushed, 2);
  });
});

test('running push twice is idempotent — second run creates no duplicate forms', async () => {
  await withDir(async (dir) => {
    const srcReg = emptyRegistry('529456');
    const pullHub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: srcReg, hub: pullHub });

    // A tiny stateful fake portal: POST appends to `store`, GET returns it.
    const store = [];
    let guidSeq = 0;
    const makeHub = (calls) => mockHub(
      [
        ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: { results: [] } }],
        ['POST /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
        ['GET /forms/v2/forms', () => ({ ok: true, status: 200, json: store.map((f) => ({ ...f })) })],
        ['POST /forms/v2/forms', ({ body }) => {
          guidSeq += 1;
          const guid = `dev-guid-${guidSeq}`;
          store.push({ guid, name: body.name, formFieldGroups: body.formFieldGroups });
          return { ok: true, status: 200, json: { guid } };
        }],
        ['PUT /forms/v2/forms', () => ({ ok: true, status: 200, json: {} })],
      ],
      calls,
    );

    // First push: creates both forms.
    const reg1 = emptyRegistry('246389711');
    const calls1 = [];
    await push(ACCT, { contentDir: dir, registry: reg1, hub: makeHub(calls1) });
    assert.equal(store.length, 2, 'first push created both forms');
    const guidsAfterFirst = { ...reg1.forms };

    // Second push against the SAME (now-populated) portal: must not create dupes.
    const reg2 = emptyRegistry('246389711');
    const calls2 = [];
    await push(ACCT, { contentDir: dir, registry: reg2, hub: makeHub(calls2) });
    const secondCreates = calls2.filter((c) => c.method === 'POST' && c.path === '/forms/v2/forms');
    assert.equal(secondCreates.length, 0, 'second push created no forms');
    assert.equal(store.length, 2, 'portal still has exactly 2 forms (no duplicates)');
    // registry on the second run resolves to the SAME guids the first run created
    assert.deepEqual(reg2.forms, guidsAfterFirst, 'guids are stable across re-push');
  });
});

test('renamed/missing-on-target form is created fresh and registry points at the new guid', async () => {
  await withDir(async (dir) => {
    const srcReg = emptyRegistry('529456');
    const pullHub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: srcReg, hub: pullHub });

    // Target has the OLD name only ('Some Other Form!!' present, 'contact' absent
    // because it was renamed on the source). The contact form must be created new;
    // the registry must resolve @form:contact to the NEW guid, not be left unmapped.
    const tgtReg = emptyRegistry('246389711');
    const calls = [];
    const pushHub = mockHub(
      [
        ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: { results: [] } }],
        ['POST /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
        ['GET /forms/v2/forms', {
          ok: true, status: 200,
          json: [rawForm('Some Other Form!!', 'dev-o', [{ name: 'email', required: true }])],
        }],
        ['POST /forms/v2/forms', { ok: true, status: 200, json: { guid: 'dev-new-contact' } }],
        ['PUT /forms/v2/forms', { ok: true, status: 200, json: {} }],
      ],
      calls,
    );

    await push(ACCT, { contentDir: dir, registry: tgtReg, hub: pushHub });

    const creates = calls.filter((c) => c.method === 'POST' && c.path === '/forms/v2/forms');
    assert.equal(creates.length, 1, 'exactly the missing form was created');
    assert.equal(creates[0].body.name, 'Website: Contact (general)');
    // BOTH keys resolve in the registry: the new one and the pre-existing one.
    assert.equal(tgtReg.forms.contact, 'dev-new-contact', '@form:contact resolves to new guid');
    assert.equal(tgtReg.forms['some-other-form'], 'dev-o', 'pre-existing form still mapped');
  });
});

test('populateRegistry from existing target guids without any form write (no-drift path)', async () => {
  await withDir(async (dir) => {
    const srcReg = emptyRegistry('529456');
    const pullHub = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: srcReg, hub: pullHub });

    // Target forms are byte-identical (no drift) so no PUT/POST runs, yet the
    // registry MUST still be populated so downstream @form resolution works.
    const tgtReg = emptyRegistry('246389711');
    const calls = [];
    const pushHub = mockHub(
      [
        ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: { results: [] } }],
        ['POST /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
        ['GET /forms/v2/forms', {
          ok: true, status: 200,
          json: [
            rawForm('Website: Contact (general)', 'dev-c', [
              { name: 'firstname', required: false }, { name: 'email', required: true },
            ]),
            rawForm('Some Other Form!!', 'dev-o', [{ name: 'email', required: true }]),
          ],
        }],
      ],
      calls,
    );

    await push(ACCT, { contentDir: dir, registry: tgtReg, hub: pushHub });

    const formWrites = calls.filter(
      (c) => (c.method === 'POST' || c.method === 'PUT') && c.path.startsWith('/forms/v2/forms'),
    );
    assert.equal(formWrites.length, 0, 'no form writes on the no-drift path');
    // Registry populated purely from the existing target guids — consumers can resolve.
    assert.equal(tgtReg.forms.contact, 'dev-c');
    assert.equal(tgtReg.forms['some-other-form'], 'dev-o');
    assert.equal(tgtReg.__rev_forms, undefined, 'reverse index left invalidated for rebuild');
  });
});

// =============================================================================
// Round-trip identity: pull -> push -> pull converges (name-keyed, no guid churn)
// =============================================================================

test('pull->push->pull converges on identical canonical files', async () => {
  await withDir(async (dir) => {
    const reg1 = emptyRegistry('529456');
    const hub1 = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: PROD_FORMS }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: reg1, hub: hub1 });
    const before = readCanonicalForms(dir).sort((a, b) => a.key.localeCompare(b.key));
    const propsBefore = readFileSync(join(dir, 'forms', 'properties.json'), 'utf8');

    // push to dev (create), then pull back from dev — dev now returns the same
    // canonical shape under the same names.
    const reg2 = emptyRegistry('246389711');
    const pushHub = mockHub([
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: { results: PROD_PROPS.results } }],
      ['PATCH /crm/v3/properties/contacts', { ok: true, status: 200, json: {} }],
      ['GET /forms/v2/forms', { ok: true, status: 200, json: [] }],
      ['POST /forms/v2/forms', { ok: true, status: 200, json: { guid: 'dev-x' } }],
    ]);
    await push(ACCT, { contentDir: dir, registry: reg2, hub: pushHub });

    const reg3 = emptyRegistry('246389711');
    const pullHub2 = mockHub([
      ['GET /forms/v2/forms', { ok: true, status: 200, json: [
        rawForm('Website: Contact (general)', 'dev-1', PROD_FORMS[0].formFieldGroups[0].fields),
        rawForm('Some Other Form!!', 'dev-2', PROD_FORMS[1].formFieldGroups[0].fields),
      ] }],
      ['GET /crm/v3/properties/contacts', { ok: true, status: 200, json: PROD_PROPS }],
    ]);
    await pull(ACCT, { contentDir: dir, registry: reg3, hub: pullHub2 });

    const after = readCanonicalForms(dir).sort((a, b) => a.key.localeCompare(b.key));
    const propsAfter = readFileSync(join(dir, 'forms', 'properties.json'), 'utf8');
    assert.deepEqual(after, before, 'forms converge byte-identically across round-trip');
    assert.equal(propsAfter, propsBefore, 'properties converge');
  });
});
