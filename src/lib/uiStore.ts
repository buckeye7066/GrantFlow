import { create } from 'zustand';

interface FilterState {
  search: string;
  statusFilter: string[];
  applicantTypeFilter: string[];
  setSearch: (s: string) => void;
  setStatusFilter: (s: string[]) => void;
  setApplicantTypeFilter: (s: string[]) => void;
  reset: () => void;
}

export const useUiStore = create<FilterState>((set) => ({
  search: '',
  statusFilter: [],
  applicantTypeFilter: [],
  setSearch: (search) => set({ search }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setApplicantTypeFilter: (applicantTypeFilter) => set({ applicantTypeFilter }),
  reset: () => set({ search: '', statusFilter: [], applicantTypeFilter: [] }),
}));
