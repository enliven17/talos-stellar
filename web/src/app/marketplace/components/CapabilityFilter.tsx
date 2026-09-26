'use client';

import { useState, useEffect } from 'react';
import type { CapabilityFilter as CapabilityFilterType } from '@/app/api/marketplace/search/types';

interface CapabilityFilterProps {
  onFilterChange: (capabilities: string[]) => void;
}

export default function CapabilityFilter({ onFilterChange }: CapabilityFilterProps) {
  const [filters, setFilters] = useState<CapabilityFilterType[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchFilters() {
      try {
        const response = await fetch('/api/marketplace/search?capabilities=[]');
        if (!response.ok) {
          throw new Error('Failed to fetch filters');
        }
        const data = await response.json();
        setFilters(data.filters.capabilities);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    fetchFilters();
  }, []);

  const handleToggle = (id: string) => {
    const newSelected = selected.includes(id)
      ? selected.filter((s) => s !== id)
      : [...selected, id];
    setSelected(newSelected);
    onFilterChange(newSelected);
  };

  if (loading) {
    return <div className="p-4">Loading filters...</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">Error loading filters: {error}</div>;
  }

  return (
    <div className="p-4 border rounded">
      <h3 className="text-lg font-semibold mb-2">Capabilities</h3>
      <div className="space-y-2">
        {filters.map((filter) => (
          <label key={filter.id} className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={selected.includes(filter.id)}
              onChange={() => handleToggle(filter.id)}
              className="rounded border-gray-300"
            />
            <span>{filter.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}