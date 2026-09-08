// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t, type Locale } from '../../dashboard/src/lib/i18n';
import { typeLabel } from '../../dashboard/src/lib/entity-display';

afterEach(() => setLocale('en'));

const expected: Record<Exclude<Locale, 'en' | 'zh-TW' | 'zh-CN'>, Record<string, string>> = {
  ja: {
    'insights.statPending': '保留中',
    'insights.statApplied': '適用済み',
    'insights.statRejected': '却下済み',
    'insights.filter.pending': '保留中',
    'insights.filter.applied': '適用済み',
    'insights.filter.rejected': '却下済み',
    'insights.status.pending': '保留中',
    'insights.status.applied': '適用済み',
    'insights.status.rejected': '却下済み',
  },
  ko: {
    'insights.statPending': '대기 중',
    'insights.statApplied': '적용됨',
    'insights.statRejected': '거부됨',
    'insights.filter.pending': '대기 중',
    'insights.filter.applied': '적용됨',
    'insights.filter.rejected': '거부됨',
    'insights.status.pending': '대기 중',
    'insights.status.applied': '적용됨',
    'insights.status.rejected': '거부됨',
  },
  pt: {
    'insights.statPending': 'pendente',
    'insights.statApplied': 'aplicada',
    'insights.statRejected': 'rejeitada',
    'insights.filter.pending': 'Pendente',
    'insights.filter.applied': 'Aplicada',
    'insights.filter.rejected': 'Rejeitada',
    'insights.status.pending': 'pendente',
    'insights.status.applied': 'aplicada',
    'insights.status.rejected': 'rejeitada',
  },
  fr: {
    'insights.statPending': 'en attente',
    'insights.statApplied': 'appliquée',
    'insights.statRejected': 'rejetée',
    'insights.filter.pending': 'En attente',
    'insights.filter.applied': 'Appliquée',
    'insights.filter.rejected': 'Rejetée',
    'insights.status.pending': 'en attente',
    'insights.status.applied': 'appliquée',
    'insights.status.rejected': 'rejetée',
  },
  de: {
    'insights.statPending': 'ausstehend',
    'insights.statApplied': 'angewendet',
    'insights.statRejected': 'abgelehnt',
    'insights.filter.pending': 'Ausstehend',
    'insights.filter.applied': 'Angewendet',
    'insights.filter.rejected': 'Abgelehnt',
    'insights.status.pending': 'ausstehend',
    'insights.status.applied': 'angewendet',
    'insights.status.rejected': 'abgelehnt',
  },
  vi: {
    'insights.statPending': 'đang chờ',
    'insights.statApplied': 'đã áp dụng',
    'insights.statRejected': 'đã từ chối',
    'insights.filter.pending': 'Đang chờ',
    'insights.filter.applied': 'Đã áp dụng',
    'insights.filter.rejected': 'Đã từ chối',
    'insights.status.pending': 'đang chờ',
    'insights.status.applied': 'đã áp dụng',
    'insights.status.rejected': 'đã từ chối',
  },
  es: {
    'insights.statPending': 'pendiente',
    'insights.statApplied': 'aplicada',
    'insights.statRejected': 'rechazada',
    'insights.filter.pending': 'Pendiente',
    'insights.filter.applied': 'Aplicada',
    'insights.filter.rejected': 'Rechazada',
    'insights.status.pending': 'pendiente',
    'insights.status.applied': 'aplicada',
    'insights.status.rejected': 'rechazada',
  },
  th: {
    'insights.statPending': 'รอดำเนินการ',
    'insights.statApplied': 'นำไปใช้แล้ว',
    'insights.statRejected': 'ปฏิเสธแล้ว',
    'insights.filter.pending': 'รอดำเนินการ',
    'insights.filter.applied': 'นำไปใช้แล้ว',
    'insights.filter.rejected': 'ปฏิเสธแล้ว',
    'insights.status.pending': 'รอดำเนินการ',
    'insights.status.applied': 'นำไปใช้แล้ว',
    'insights.status.rejected': 'ปฏิเสธแล้ว',
  },
};

describe('proposal status localization', () => {
  for (const [locale, translations] of Object.entries(expected) as Array<[keyof typeof expected, Record<string, string>]>) {
    it(`translates staged proposal statuses in ${locale}`, () => {
      setLocale(locale);
      for (const [key, value] of Object.entries(translations)) {
        expect(t(key)).toBe(value);
      }
    });
  }
});

const goalLabels: Record<Locale, string> = {
  en: 'Goal',
  'zh-TW': '目標',
  'zh-CN': '目标',
  ja: '目標',
  ko: '목표',
  pt: 'Objetivo',
  fr: 'Objectif',
  de: 'Ziel',
  vi: 'Mục tiêu',
  es: 'Objetivo',
  th: 'เป้าหมาย',
};

describe('goal type localization', () => {
  for (const [locale, label] of Object.entries(goalLabels) as Array<[Locale, string]>) {
    it(`translates the work-layer goal type in ${locale}`, () => {
      setLocale(locale);
      expect(t('type.goal')).toBe(label);
    });
  }

  it('preserves arbitrary type slugs as a fallback', () => {
    setLocale('ja');
    expect(typeLabel('custom_thing')).toBe('custom_thing');
  });
});
