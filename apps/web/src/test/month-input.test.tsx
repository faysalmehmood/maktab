import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { MonthInput } from '@/components/month-input';
import { initI18n, setLanguage } from '@/i18n';

function Harness({ initial }: { initial: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <MonthInput id="m" value={v} onChange={setV} />
      <output data-testid="out">{v}</output>
    </>
  );
}

describe('MonthInput', () => {
  beforeAll(async () => {
    await initI18n();
  });

  it('names months in Urdu in the Urdu UI, keeps the value as YYYY-MM with a Latin year', async () => {
    await setLanguage('ur');
    render(<Harness initial="2026-10" />);
    const month = document.getElementById('m') as HTMLSelectElement;
    expect(month.selectedOptions[0]?.textContent).toBe('اکتوبر');
    expect(month.selectedOptions[0]?.textContent).not.toMatch(/October/);
    fireEvent.change(month, { target: { value: '03' } });
    expect(screen.getByTestId('out').textContent).toBe('2026-03');
    fireEvent.change(document.getElementById('m-year') as HTMLInputElement, {
      target: { value: '2027' },
    });
    expect(screen.getByTestId('out').textContent).toBe('2027-03');
  });

  it('names months in English in the English UI', async () => {
    await setLanguage('en');
    render(<Harness initial="2026-10" />);
    expect(
      (document.getElementById('m') as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe('October');
  });
});
