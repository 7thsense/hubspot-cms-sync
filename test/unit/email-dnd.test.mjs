import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDnDPushWidgets,
  buildDnDFlexAreas,
  countBodyModules,
  dndWidgetRank,
  HUBSPOT_DND_FALLBACK_TEMPLATE,
} from '../../src/lib/email-dnd.mjs';

test('HUBSPOT_DND_FALLBACK_TEMPLATE points at Start_from_scratch', () => {
  assert.match(HUBSPOT_DND_FALLBACK_TEMPLATE, /Start_from_scratch/);
});

test('countBodyModules counts hs_email_body variants', () => {
  assert.equal(countBodyModules({ hs_email_body: {}, hs_email_body_2: {} }), 2);
  assert.equal(countBodyModules({}), 1);
});

test('dndWidgetRank orders preview before logo before body before footer', () => {
  assert.ok(dndWidgetRank('preview_text')[0] < dndWidgetRank('logo_image')[0]);
  assert.ok(dndWidgetRank('logo_image')[0] < dndWidgetRank('hs_email_body')[0]);
  assert.ok(dndWidgetRank('hs_email_body_2')[1] > dndWidgetRank('hs_email_body')[1]);
  assert.ok(dndWidgetRank('hs_email_body')[0] < dndWidgetRank('email_can_spam')[0]);
});

test('normalizeDnDPushWidgets converts rich_text to module with order', () => {
  const out = normalizeDnDPushWidgets({
    hs_email_body: { type: 'rich_text', body: { html: '<p>Hi</p>' } },
    logo_image: { type: 'module', body: { img: { src: 'x' } } },
    email_can_spam: { type: 'module', body: { align: 'center' } },
  }, { previewText: 'Peek inside' });

  assert.equal(out.preview_text.type, 'text');
  assert.equal(out.preview_text.body.value, 'Peek inside');
  assert.equal(out.hs_email_body.type, 'module');
  assert.equal(out.logo_image.type, 'module');
  assert.ok(out.logo_image.order < out.hs_email_body.order);
  assert.ok(out.hs_email_body.order < out.email_can_spam.order);
});

test('buildDnDFlexAreas places each widget in its own section (excludes preview_text)', () => {
  const widgets = normalizeDnDPushWidgets({
    hs_email_body: { type: 'module', body: { html: '<p>Hi</p>' } },
    logo_image: { type: 'module', body: {} },
    email_can_spam: { type: 'module', body: {} },
  }, { previewText: 'Peek' });

  const flex = buildDnDFlexAreas(widgets);
  const placed = flex.main.sections.flatMap((s) => s.columns.flatMap((c) => c.widgets));
  assert.deepEqual(placed, ['logo_image', 'hs_email_body', 'email_can_spam']);
  assert.equal(flex.main.sections.length, 3);
});