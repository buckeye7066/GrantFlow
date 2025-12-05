import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import GrantHeader from '@/components/grants/GrantHeader';
import GrantOverview from '@/components/grants/GrantOverview';

export default function GrantDetail() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const grantId = searchParams.get('id');

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const { data: grant, isLoading } = useQuery({
    queryKey: ['grant', grantId],
    queryFn: async () => {
      const results = await base44.entities.Grant.filter({ id: grantId });
      return results?.[0] ?? null;
    },
    enabled: !!grantId,
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!grant) {
    return <div className="p-6">Grant not found</div>;
  }

  return (
    <div className="bg-slate-50 min-h-screen">
      <GrantHeader grant={grant} />
      <main className="max-w-7xl mx-auto p-6">
        <GrantOverview grant={grant} />
      </main>
    </div>
  );
}