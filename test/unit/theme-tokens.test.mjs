import { test } from 'node:test';
import assert from 'node:assert/strict';

import { themeFromFields, resolveThemeTokens } from '../../src/build-static.mjs';

const FIELDS = [
  {
    name: 'brand', type: 'group', children: [
      { name: 'primary_color', type: 'color', default: { color: '#5b3df5', opacity: 100 } },
      { name: 'accent_color', type: 'color', default: { color: '#f5a623', opacity: 100 } },
    ],
  },
];

test('themeFromFields maps groups + color defaults', () => {
  const theme = themeFromFields(FIELDS);
  assert.equal(theme.brand.primary_color.color, '#5b3df5');
  assert.equal(theme.brand.accent_color.color, '#f5a623');
});

test('resolveThemeTokens replaces {{ theme.* }} in CSS, leaves the rest intact', () => {
  const theme = themeFromFields(FIELDS);
  const css = ':root{ --brand: {{ theme.brand.primary_color.color }}; --accent:{{theme.brand.accent_color.color}} }\n.x{ color: var(--brand) }';
  const out = resolveThemeTokens(css, theme);
  assert.match(out, /--brand: #5b3df5;/);
  assert.match(out, /--accent:#f5a623/);
  assert.match(out, /\.x\{ color: var\(--brand\) \}/); // CSS braces untouched
  assert.doesNotMatch(out, /\{\{/);
});

test('resolveThemeTokens leaves unknown theme paths untouched (no silent blanks)', () => {
  const out = resolveThemeTokens('a:{{ theme.nope.missing }}', themeFromFields(FIELDS));
  assert.match(out, /\{\{ theme\.nope\.missing \}\}/);
});
