"use client";

import type { District } from "@/types";

interface Props {
  districts: District[];
  selectedId: string;
  onChange: (id: string) => void;
}

export default function DistrictSelector({
  districts,
  selectedId,
  onChange,
}: Props) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="district-select"
        className="text-sm font-medium text-gray-700"
      >
        School District
      </label>
      <select
        id="district-select"
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="">All Districts</option>
        {districts.map((d) => (
          <option key={d.districtId} value={d.districtId}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}
