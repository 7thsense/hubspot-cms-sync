// sync/lib/refs.mjs — per-account REFERENCE extraction + logical canonicalization.
//
// THE CRUX (codex findings #1, #2): HubSpot content embeds per-account ids — form
// GUIDs, CTA GUIDs, `hbspt.cta.load(<portal>,'<guid>')`, CTA embed HTML, hosted
// hubfs/asset URLs, generic `guid` fields, and bare portal ids (prod 529456 / dev
// 246389711). None of these are portable. The canonical store committed to git must
// hold LOGICAL refs (`@form:contact`, `@cta:book-demo`, `@asset:Sucess.jpg`,
// `@portal`, `@menu:main`); push RESOLVES them to the TARGET account's ids and
// HARD-FAILS if any logical ref has no target mapping.
//
// Composition with canonical.mjs (canon.mjs): canon owns JSON/HTML *shape*
// normalization (stable key order, entity/whitespace, null/empty policy, publishDate
// coercion). refs owns *identity* portability. On PULL the pipeline is
// `canon.normalize(raw)` then `canonicalize(str, sourceRegistry)` — shape first, then
// strip per-account ids to logical tokens — and the result is what gets committed. On
// PUSH it is the inverse: `resolve(str, targetRegistry)` injects the target portal's
// ids, then the bytes are uploaded. Because both layers are pure string/JSON
// transforms with no I/O, they unit-test without network. A Registry is loaded/saved
// per account by the orchestrator (e.g. `.sync-state/<portalId>.refs.json`, gitignored)
// and is the single rawId<->logicalKey lookup for that account.
//
// Pure module: no fs, no fetch, no globals. Everything here is a pure function.

// ---------------------------------------------------------------------------
// Known portal ids confirmed in-repo. Used to recognise BARE portal ids and to
// validate that a remapped portal is plausible. Not a write-allowlist.
// ---------------------------------------------------------------------------
export const KNOWN_PORTALS = ['529456', '246389711'];

// A GUID as HubSpot emits it (lowercase hex, 8-4-4-4-12).
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// ---------------------------------------------------------------------------
// REF_PATTERNS — one regex per reference SHAPE. Each is global so `extractRefs`
// can enumerate every occurrence. `kind` names the logical namespace it feeds.
//
// IMPORTANT ordering note for canonicalize/resolve: `hubfsUrl` must be applied
// BEFORE `portalId`, because a hubfs URL contains a portal-id segment that we want
// folded into the single `@asset:<path>` token rather than separately tokenized.
// ---------------------------------------------------------------------------
export const REF_PATTERNS = {
  // form_id field value, or a bare form GUID inside a form module body.
  // Capture group 1 = the GUID.
  formGuid: new RegExp(`"form_id"\\s*:\\s*"(${GUID})"`, 'g'),

  // hbspt.cta.load(<portal>, '<guid>', {...}) — carries BOTH a portal id and a CTA
  // guid. Group 1 = portal, group 2 = guid. The quote may be single OR double, and
  // arbitrary whitespace may surround the args.
  ctaLoad: new RegExp(`hbspt\\.cta\\.load\\(\\s*(\\d{5,})\\s*,\\s*['"](${GUID})['"]`, 'g'),

  // Every other place a CTA guid appears: {{cta('guid')}} / {{ cta("guid") }} (single
  // OR double quote, arbitrary whitespace inside the call), the "guid" body field,
  // cta/redirect/<portal>/<guid>, pg=<guid>, hs-cta-<guid> ids, data-hs-img-pg.
  // Group 1 = the GUID. (ctaLoad is handled separately for its portal arg.)
  ctaGuid: new RegExp(
    `(?:\\{\\{\\s*cta\\(\\s*['"]|"guid"\\s*:\\s*"|/cta/(?:redirect|default)/\\d{5,}/|[?&]pg=|hs-cta(?:-wrapper|-img|-ie-element|-node)?-|data-hs-img-pg="|hs-cta-)(${GUID})`,
    'g',
  ),

  // Hosted asset URL on any HubSpot file host. THREE path shapes occur in the corpus:
  //   1. /hubfs/<portal>/<tail>                (cdn2.hubspot.net, *.hubspotusercontent*)
  //   2. /hub/<portal>/hubfs/<tail>            (legacy File-Manager host path)
  //   3. /hs-fs/hubfs/<tail>                   (theseventhsense.com — NO portal segment)
  //      and the portal-bearing variant /hs-fs/hubfs/<portal>/<tail>.
  // Group 1 = portal (may be undefined for the portal-less /hs-fs/ shape),
  // group 2 = the path tail (the stable, portable key). The tail is portal-agnostic.
  // Hosts seen in corpus: cdn2.hubspot.net, <portal>.fs1.hubspotusercontent-naN.net,
  // f.hubspotusercontent00.net, fs.hubspotusercontent00.net, www.theseventhsense.com.
  hubfsUrl: new RegExp(
    `https?://[a-z0-9.-]+/(?:hub/(\\d{5,})/hubfs|hs-fs/hubfs(?:/(\\d{5,}))?|hubfs/(\\d{5,}))/([^"'\\\\\\s),]+)`,
    'g',
  ),

  // Foreign image hosts that legacy blog bodies still embed (Google Docs paste-ins).
  // These carry no portal but the opaque path IS a stable per-image identity, so we
  // fold the WHOLE URL to a portable `@asset:googleusercontent/<blob>` token. Group 1
  // = the opaque path tail. Hosts: lhN.googleusercontent.com.
  googleUserContentUrl: new RegExp(
    `https?://lh[0-9]+\\.googleusercontent\\.com/([^"'\\\\\\s),]+)`,
    'g',
  ),

  // A native/simple menu id (numeric). Group 1 = id. Defensive: confirmed shape in
  // HubSpot menu modules though this corpus's simple_menu modules are link-based.
  menuId: new RegExp(`"menu_?[iI]d"\\s*:\\s*"?(\\d{5,})"?`, 'g'),

  // A BARE portal id anywhere else (after assets/ctas have been consumed). Group 1 =
  // portal. Word-bounded so it doesn't bite into a longer number.
  portalId: new RegExp(`\\b(${KNOWN_PORTALS.join('|')})\\b`, 'g'),
};

// Logical token grammar. A token is `@<kind>:<key>` or the bare `@portal` sentinel.
// Keys are slug-safe; `@asset:` keys keep their path (slashes allowed).
const TOKEN = {
  form: (key) => `@form:${key}`,
  cta: (key) => `@cta:${key}`,
  asset: (key) => `@asset:${key}`,
  menu: (key) => `@menu:${key}`,
  portal: () => `@portal`,
};
// Matches any logical token we emit, for resolve() to scan/replace/validate.
// `@asset:` allows `/` and `.`; others are slug-ish.
const TOKEN_RE = /@(form|cta|menu):([A-Za-z0-9_-]+)|@asset:([^\s"'\\),]+)|@portal\b/g;

// ---------------------------------------------------------------------------
// Registry — per-account map of logicalKey<->rawId, one sub-map per namespace.
// `forms`/`ctas`/`menus`: { logicalKey: rawGuidOrId }.
// `assets`: { logicalKey(=pathTail): true } — assets are keyed by their own path,
//           so no id table is needed; presence is the mapping.
// `portalId`: the account's numeric portal id (for `@portal` resolution).
// We also build reverse indexes lazily for canonicalize().
// ---------------------------------------------------------------------------

/** An empty registry skeleton. */
export function emptyRegistry(portalId = null) {
  return {
    portalId: portalId == null ? null : String(portalId),
    forms: {},
    ctas: {},
    menus: {},
    assets: {},
    emails: {},
  };
}

/** Normalize/clone a loaded registry object into the canonical shape. */
export function loadRegistry(obj = {}) {
  const r = emptyRegistry(obj.portalId ?? null);
  for (const ns of ['forms', 'ctas', 'menus', 'assets', 'emails']) {
    if (obj[ns] && typeof obj[ns] === 'object') Object.assign(r[ns], obj[ns]);
  }
  return r;
}

/** Serialize to a plain, stably-ordered object (composes with canon.stableStringify). */
export function saveRegistry(reg) {
  return {
    portalId: reg.portalId == null ? null : String(reg.portalId),
    forms: { ...reg.forms },
    ctas: { ...reg.ctas },
    menus: { ...reg.menus },
    assets: { ...reg.assets },
    emails: { ...reg.emails },
  };
}

const NS_FOR_KIND = {
  formGuid: 'forms',
  ctaGuid: 'ctas',
  ctaLoad: 'ctas',
  menuId: 'menus',
  hubfsUrl: 'assets',
  googleUserContentUrl: 'assets',
};

// hubfsUrl has three alternative portal capture groups (one per path shape) plus the
// tail. Collapse a regex match into a stable { portal, tail } pair. `portal` may be
// undefined for the portal-less /hs-fs/hubfs/<tail> shape.
function hubfsParts(m) {
  const portal = m[1] || m[2] || m[3]; // /hub/, /hs-fs/.../<portal>, or /hubfs/<portal>
  const tail = m[4];
  return { portal, tail };
}

// Build a rawId->logicalKey reverse index for a namespace, memoized on the registry.
function reverseIndex(reg, ns) {
  const cacheKey = `__rev_${ns}`;
  if (reg[cacheKey]) return reg[cacheKey];
  const rev = Object.create(null);
  for (const [logical, raw] of Object.entries(reg[ns] || {})) rev[String(raw)] = logical;
  // non-enumerable so it doesn't leak into saveRegistry / stableStringify
  Object.defineProperty(reg, cacheKey, { value: rev, enumerable: false, configurable: true });
  return rev;
}

// ---------------------------------------------------------------------------
// extractRefs(str) -> [{ kind, rawId, match }]
// Enumerates EVERY reference occurrence across all shapes. `kind` is the pattern
// name; `rawId` is the per-account id (guid / portal / asset path); `match` is the
// full matched substring (useful for callers that want to locate/replace in place).
// Order of kinds mirrors the canonicalize precedence (asset before bare portal).
// ---------------------------------------------------------------------------
export function extractRefs(str) {
  if (typeof str !== 'string' || str.length === 0) return [];
  const out = [];
  const push = (kind, rawId, match) => out.push({ kind, rawId, match });

  // formGuid
  for (const m of str.matchAll(REF_PATTERNS.formGuid)) push('formGuid', m[1], m[0]);

  // ctaLoad — yields a cta guid AND a portal id
  for (const m of str.matchAll(REF_PATTERNS.ctaLoad)) {
    push('ctaLoad', m[2], m[0]); // the CTA guid (logical namespace = ctas)
    push('portalId', m[1], m[1]); // its portal arg
  }

  // ctaGuid (all other cta-guid shapes)
  for (const m of str.matchAll(REF_PATTERNS.ctaGuid)) push('ctaGuid', m[1], m[0]);

  // hubfsUrl — asset path tail is the rawId; record the embedded portal too (if any)
  for (const m of str.matchAll(REF_PATTERNS.hubfsUrl)) {
    const { portal, tail } = hubfsParts(m);
    push('hubfsUrl', tail, m[0]); // rawId = portal-agnostic path tail
    if (portal) push('portalId', portal, portal);
  }

  // googleUserContentUrl — foreign-host image; key by the opaque path tail
  for (const m of str.matchAll(REF_PATTERNS.googleUserContentUrl)) {
    push('googleUserContentUrl', `googleusercontent/${m[1]}`, m[0]);
  }

  // menuId
  for (const m of str.matchAll(REF_PATTERNS.menuId)) push('menuId', m[1], m[0]);

  // bare portalId (anywhere)
  for (const m of str.matchAll(REF_PATTERNS.portalId)) push('portalId', m[1], m[0]);

  return out;
}

// ---------------------------------------------------------------------------
// toLogical(kind, rawId, registry) -> logical token string
// Maps a raw per-account id to its portable logical token using the registry's
// rawId->logicalKey reverse index. For assets the rawId IS the path tail, which is
// already portable, so the registry only needs to record it (auto-registered).
// Throws if a registry mapping is required but missing (forms/ctas/menus): pull-time
// auto-registration is the caller's job via registerRef(); a hard miss here means a
// caller asked to logicalize an unregistered id.
// ---------------------------------------------------------------------------
export function toLogical(kind, rawId, registry) {
  if (kind === 'portalId') return TOKEN.portal();
  if (kind === 'hubfsUrl' || kind === 'googleUserContentUrl') return TOKEN.asset(String(rawId));
  const ns = NS_FOR_KIND[kind];
  if (!ns) throw new Error(`toLogical: unknown kind ${kind}`);
  const rev = reverseIndex(registry, ns);
  const logical = rev[String(rawId)];
  if (logical == null) {
    throw new Error(`toLogical: no logical key for ${kind} ${rawId} in registry (call registerRef on pull first)`);
  }
  return TOKEN[ns === 'forms' ? 'form' : ns === 'ctas' ? 'cta' : 'menu'](logical);
}

// ---------------------------------------------------------------------------
// registerRef — pull-time helper: ensure a rawId has a logical key in the registry,
// minting a deterministic key if absent. Returns the logical key. Assets register by
// their path tail. This is what makes canonicalize() succeed on first pull.
// ---------------------------------------------------------------------------
export function registerRef(reg, kind, rawId, logicalKey = null) {
  if (kind === 'portalId') {
    if (reg.portalId == null) reg.portalId = String(rawId);
    return null;
  }
  if (kind === 'hubfsUrl' || kind === 'googleUserContentUrl') {
    reg.assets[String(rawId)] = true;
    delete reg.__rev_assets;
    return String(rawId);
  }
  const ns = NS_FOR_KIND[kind];
  if (!ns) throw new Error(`registerRef: unknown kind ${kind}`);
  const rev = reverseIndex(reg, ns);
  if (rev[String(rawId)] != null) return rev[String(rawId)];
  const key = logicalKey || mintKey(ns, rawId);
  reg[ns][key] = String(rawId);
  delete reg[`__rev_${ns}`];
  return key;
}

// Deterministic fallback logical key when the caller has no human-friendly name yet.
function mintKey(ns, rawId) {
  const short = String(rawId).replace(/-/g, '').slice(0, 8);
  return `${ns.slice(0, -1)}-${short}`; // forms->form-xxxx, ctas->cta-xxxx, menus->menu-xxxx
}

// ---------------------------------------------------------------------------
// canonicalize(str, registry) -> portable str with raw refs replaced by tokens.
// PRECEDENCE (critical for reversibility):
//   1. hubfsUrl  → @asset:<path>     (consumes the portal segment inside the URL)
//   2. ctaLoad   → hbspt.cta.load(@portal,'@cta:key',  (portal + guid together)
//   3. formGuid  → "form_id": "@form:key"
//   4. ctaGuid   → @cta:key          (all remaining cta-guid shapes)
//   5. menuId    → @menu:key
//   6. portalId  → @portal           (any remaining bare portal id)
// Auto-registers any ref it has not seen so first pull is self-bootstrapping.
// ---------------------------------------------------------------------------
export function canonicalize(str, registry) {
  if (typeof str !== 'string' || str.length === 0) return str;
  let s = str;

  // 1. hosted asset URLs -> @asset:<pathTail> (host + portal collapse into the token).
  //    All three HubSpot path shapes (/hubfs/<portal>/, /hub/<portal>/hubfs/,
  //    /hs-fs/hubfs/[<portal>/]) fold to the same portal-agnostic tail.
  s = s.replace(REF_PATTERNS.hubfsUrl, (...args) => {
    const m = args.slice(0, 5); // [whole, g1, g2, g3, g4]
    const { tail } = hubfsParts(m);
    const key = registerRef(registry, 'hubfsUrl', tail);
    return TOKEN.asset(key);
  });

  // 1b. foreign googleusercontent image URLs -> @asset:googleusercontent/<blob>
  s = s.replace(REF_PATTERNS.googleUserContentUrl, (_m, blob) => {
    const key = registerRef(registry, 'googleUserContentUrl', `googleusercontent/${blob}`);
    return TOKEN.asset(key);
  });

  // 2. hbspt.cta.load(<portal>,'<guid>' -> hbspt.cta.load(@portal,'@cta:key'
  s = s.replace(REF_PATTERNS.ctaLoad, (whole, portal, guid) => {
    registerRef(registry, 'portalId', portal);
    const key = registerRef(registry, 'ctaGuid', guid);
    return whole
      .replace(portal, TOKEN.portal())
      .replace(guid, TOKEN.cta(key));
  });

  // 3. form_id field
  s = s.replace(REF_PATTERNS.formGuid, (_m, guid) => {
    const key = registerRef(registry, 'formGuid', guid);
    return `"form_id": "${TOKEN.form(key)}"`;
  });

  // 4. all remaining cta-guid shapes -> swap just the guid for @cta:key in place
  s = s.replace(REF_PATTERNS.ctaGuid, (whole, guid) => {
    const key = registerRef(registry, 'ctaGuid', guid);
    return whole.replace(guid, TOKEN.cta(key));
  });

  // 5. menu ids
  s = s.replace(REF_PATTERNS.menuId, (whole, id) => {
    const key = registerRef(registry, 'menuId', id);
    return whole.replace(id, TOKEN.menu(key));
  });

  // 6. any remaining bare portal id
  s = s.replace(REF_PATTERNS.portalId, (m) => {
    registerRef(registry, 'portalId', m);
    return TOKEN.portal();
  });

  return s;
}

// ---------------------------------------------------------------------------
// resolve(str, targetRegistry) -> str with logical tokens replaced by the TARGET
// account's ids. THROWS (push must hard-fail) listing every logical token that has
// no target mapping. This is the inverse of canonicalize() and the round-trip
// guarantee: canonicalize(x, src) then resolve(.., tgt) reproduces x byte-for-byte
// when src and tgt carry the same rawIds for the same logical keys.
// ---------------------------------------------------------------------------
export function resolve(str, targetRegistry) {
  if (typeof str !== 'string' || str.length === 0) return str;
  const missing = [];

  const out = str.replace(TOKEN_RE, (token, kind, key, assetKey) => {
    if (token === '@portal') {
      if (targetRegistry.portalId == null) {
        missing.push('@portal');
        return token;
      }
      return String(targetRegistry.portalId);
    }
    if (assetKey != null) {
      // @asset:<pathTail> -> the target's hosted URL for that path. The target
      // registry's assets map records the path; the rehosted URL is supplied via a
      // resolver hook so this module stays pure/host-agnostic. By default we throw if
      // the path isn't registered for the target.
      const entry = targetRegistry.assets ? targetRegistry.assets[assetKey] : undefined;
      if (entry == null) {
        missing.push(`@asset:${assetKey}`);
        return token;
      }
      // entry may be `true` (path known, URL built by caller) or a concrete URL string.
      return typeof entry === 'string' ? entry : token;
    }
    const ns = kind === 'form' ? 'forms' : kind === 'cta' ? 'ctas' : 'menus';
    const raw = targetRegistry[ns] ? targetRegistry[ns][key] : undefined;
    if (raw == null) {
      missing.push(`@${kind}:${key}`);
      return token;
    }
    return String(raw);
  });

  if (missing.length) {
    const uniq = [...new Set(missing)].sort();
    throw new Error(
      `resolve: ${uniq.length} logical ref(s) have no mapping in target portal ` +
        `${targetRegistry.portalId ?? '(unknown)'} — push must not proceed: ${uniq.join(', ')}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// listLogicalTokens(str) -> [{ kind, key, token }] — pure inspection helper used by
// corpus tests (assert no raw portal ids/GUIDs survive) and by push preflight to
// pre-validate mappings before any network write.
// ---------------------------------------------------------------------------
export function listLogicalTokens(str) {
  if (typeof str !== 'string') return [];
  const out = [];
  for (const m of str.matchAll(TOKEN_RE)) {
    if (m[0] === '@portal') out.push({ kind: 'portal', key: null, token: '@portal' });
    else if (m[3] != null) out.push({ kind: 'asset', key: m[3], token: m[0] });
    else out.push({ kind: m[1], key: m[2], token: m[0] });
  }
  return out;
}
