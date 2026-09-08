// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from '../../dashboard/src/lib/i18n';

describe('Dashboard empty pending-review copy', () => {
  afterEach(() => setLocale('en'));

  it('uses user-facing language instead of internal agent orchestration terms', () => {
    setLocale('zh-TW');
    const copy = t('insights.emptyPending');
    expect(copy).toContain('待審');
    expect(copy).not.toMatch(/work_package|agent|dispatch|派送|喚醒/i);
  });
});
