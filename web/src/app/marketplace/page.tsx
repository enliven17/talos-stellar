'use client';

import { useState, useEffect } from 'react';
import CapabilityFilter from './components/CapabilityFilter';
import type { MarketplaceSearchResult } from '@/app/api/marketplace/search/types';

export default function MarketplacePage() {
  const [results, setResults] = useState<MarketplaceSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);

  useEffect(() => {
    async function search() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (searchQuery) params.set('q', searchQuery);
        if (selectedCapabilities.length > 0) {
          params.set('capabilities', JSON.stringify(selectedCapabilities));
        }
        params.set('page', '1');
        params.set('limit', '20');

        const response = await fetch(`/api/marketplace/search?${params.toString()}`);
        if (!response.ok) {
          throw new Error('Search failed');
        }
        const data = await response.json();
        setResults(data.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    const timeoutId = setTimeout(search, 300);
    return () => clearTimeout(timeoutId);
  }, [searchQuery, selectedCapabilities]);

  const handleFilterChange = (capabilities: string[]) => {
    setSelectedCapabilities(capabilities);
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Marketplace</h1>
      <div className="flex gap-4">
        <div className="w-1/4">
          <CapabilityFilter onFilterChange={handleFilterChange} />
        </div>
        <div className="w-3/4">
          <input
            type="text"
            placeholder="Search marketplace..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full p-2 border rounded mb-4"
          />
          {loading && <div>Loading...</div>}
          {error && <div className="text-red-500">{error}</div>}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((item) => (
              <div key={item.id} className="border p-4 rounded">
                <h2 className="text-lg font-semibold">{item.title}</h2>
                <p className="text-sm text-gray-600">{item.description}</p>
                <p className="mt-2">${item.price} {item.currency}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}