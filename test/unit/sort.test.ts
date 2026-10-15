import { describe, it, expect } from 'vitest';
import { sortFindingsForReport } from '../../src/reporting/reporters.js';
import type { Finding } from '../../src/types/index.js';

function f(over: Partial<Finding>): Finding {
  return {
    id: 'x',
    type: 'meta_missing',
    severity: 'info',
    message: 'm',
    page: 'p',
    ...over,
  };
}

describe('sortFindingsForReport', () => {
  it('orders errors before warnings before info', () => {
    const list = [
      f({ id: 'info1', severity: 'info' }),
      f({ id: 'err1', severity: 'error' }),
      f({ id: 'warn1', severity: 'warning' }),
    ];
    const sorted = sortFindingsForReport(list);
    expect(sorted.map((x) => x.id)).toEqual(['err1', 'warn1', 'info1']);
  });

  it('groups by type within severity', () => {
    const list = [
      f({ id: 'a', type: 'meta_missing', severity: 'error' }),
      f({ id: 'b', type: 'link_broken', severity: 'error' }),
      f({ id: 'c', type: 'image_broken', severity: 'error' }),
    ];
    const sorted = sortFindingsForReport(list);
    expect(sorted.map((x) => x.type)).toEqual(['image_broken', 'link_broken', 'meta_missing']);
  });

  it('is stable by id within a type', () => {
    const list = [
      f({ id: 'z', type: 'meta_missing', severity: 'warning' }),
      f({ id: 'a', type: 'meta_missing', severity: 'warning' }),
    ];
    const sorted = sortFindingsForReport(list);
    expect(sorted.map((x) => x.id)).toEqual(['a', 'z']);
  });

  it('does not mutate input order beyond producing a new array', () => {
    const list = [
      f({ id: 'info', severity: 'info' }),
      f({ id: 'err', severity: 'error' }),
    ];
    const inputOrder = list.map((x) => x.id);
    sortFindingsForReport(list);
    expect(list.map((x) => x.id)).toEqual(inputOrder);
  });
});