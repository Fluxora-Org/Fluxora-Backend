import React from 'react';
import { ReflectorOracle, type FiatCurrency } from '../lib/stellar/reflector.js';

export interface AmountDisplayProps {
  amount: number;
  assetCode: string;
  assetIssuer: string;
  currency: FiatCurrency;
  fiatCurrency?: FiatCurrency;
  oracle?: ReflectorOracle;
  showFiat?: boolean;
}

export function AmountDisplay({
  amount,
  assetCode,
  assetIssuer,
  currency,
  fiatCurrency = 'USD',
  oracle,
  showFiat = true,
}: AmountDisplayProps): JSX.Element {
  const [fiatValue, setFiatValue] = React.useState<string | undefined>();

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!showFiat) {
        setFiatValue(undefined);
        return;
      }
      const resolvedOracle = oracle ?? new ReflectorOracle();
      const formatted = await resolvedOracle.formatAmount(amount, assetCode, assetIssuer, fiatCurrency);
      if (!cancelled) {
        setFiatValue(formatted);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [amount, assetCode, assetIssuer, fiatCurrency, oracle, showFiat]);

  return (
    <span>
      <span>{amount}</span>
      {fiatValue ? <span>{` ${fiatValue}`}</span> : null}
    </span>
  );
}
