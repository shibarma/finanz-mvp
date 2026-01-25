"use client";

import { useState } from "react";

export default function CurrencyPage() {
  const [usdAmount, setUsdAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [eurResult, setEurResult] = useState<number | null>(null);
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConvert = async () => {
    const usd = parseFloat(usdAmount);
    
    // Validate input
    if (isNaN(usd) || usd <= 0) {
      setError("Please enter a valid positive USD amount");
      setEurResult(null);
      setFxRate(null);
      return;
    }

    setLoading(true);
    setError(null);
    setEurResult(null);
    setFxRate(null);

    try {
      // Call Frankfurter API directly from browser
      const response = await fetch("https://api.frankfurter.dev/v1/latest?base=USD");
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.rates || !data.rates.EUR) {
        throw new Error("Invalid API response");
      }

      const rate = data.rates.EUR;
      const eur = usd * rate;

      setFxRate(rate);
      setEurResult(eur);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch exchange rate");
      setEurResult(null);
      setFxRate(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-md">
        <h1 className="mb-6 text-2xl font-bold text-neutral-800">
          USD to EUR Converter
        </h1>

        <div className="mb-4">
          <label
            htmlFor="usd-input"
            className="mb-2 block text-sm font-medium text-neutral-700"
          >
            USD Amount
          </label>
          <input
            id="usd-input"
            type="number"
            step="0.01"
            min="0"
            value={usdAmount}
            onChange={(e) => setUsdAmount(e.target.value)}
            placeholder="Enter USD amount"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-neutral-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            disabled={loading}
          />
        </div>

        <button
          onClick={handleConvert}
          disabled={loading}
          className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Converting..." : "Convert USD → EUR"}
        </button>

        {error && (
          <div className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {eurResult !== null && (
          <div className="mt-6 rounded bg-green-50 p-4">
            <div className="mb-2 text-lg font-semibold text-green-800">
              {eurResult.toFixed(2)} €
            </div>
            {fxRate !== null && (
              <div className="text-xs text-green-700">
                Rate: 1 USD = {fxRate.toFixed(4)} EUR
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
