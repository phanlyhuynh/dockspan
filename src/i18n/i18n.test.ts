import { afterEach, describe, expect, it } from 'vitest';
import { getLang, setLang, t, tBackend } from './index';
import { EN } from './en';
import { VI, VI_BACKEND } from './vi';

const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

afterEach(() => setLang('en'));

describe('i18n', () => {
  it('en.ts and vi.ts have the same keys, and keys are English', () => {
    expect(Object.keys(VI).sort()).toEqual(Object.keys(EN).sort());
    for (const k of Object.keys(EN)) expect(k, k).not.toMatch(VIETNAMESE);
  });
  it('every translation keeps the placeholders of its key', () => {
    for (const [k, v] of Object.entries(VI)) expect(ph(v), k).toBe(ph(k));
    for (const [k, v] of Object.entries(EN)) expect(ph(v), k).toBe(ph(k));
    for (const [k, v] of Object.entries(VI_BACKEND)) expect(ph(v), k).toBe(ph(k));
  });
  it('English uses the key, Vietnamese looks it up and fills in values', () => {
    expect(getLang()).toBe('en');
    expect(t('{name} is now running', { name: 'web' })).toBe('web is now running');
    setLang('vi');
    expect(t('{name} is now running', { name: 'web' })).toBe('web đã chạy');
    expect(t('Not in the dictionary')).toBe('Not in the dictionary');
  });
  it('translates English backend errors into Vietnamese by pattern', () => {
    setLang('vi');
    expect(tBackend('Docker Engine is not running')).toBe('Docker Engine chưa chạy');
    expect(tBackend('Could not connect to tcp://10.0.0.25:2376: i/o timeout')).toBe('Không kết nối được tcp://10.0.0.25:2376: i/o timeout');
    expect(tBackend('No such container: abc')).toBe('No such container: abc');
    setLang('en');
    expect(tBackend('Docker Engine is not running')).toBe('Docker Engine is not running');
  });
});
