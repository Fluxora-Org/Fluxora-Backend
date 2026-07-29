import React from 'react';
import { type FiatCurrency } from '../lib/stellar/reflector.js';

export interface SettingsProps {
  fiatCurrency?: FiatCurrency;
  onFiatCurrencyChange?: (currency: FiatCurrency) => void;
}

export function Settings({ fiatCurrency = 'USD', onFiatCurrencyChange }: SettingsProps): JSX.Element {
  return (
    <div>
      <label htmlFor="fiat-currency">Fiat currency</label>
      <select
        id="fiat-currency"
        value={fiatCurrency}
        onChange={(event) => onFiatCurrencyChange?.(event.target.value as FiatCurrency)}
      >
        <option value="USD">USD</option>
        <option value="EUR">EUR</option>
        <option value="GBP">GBP</option>
        <option value="NGN">NGN</option>
      </select>
    </div>
  );
}
