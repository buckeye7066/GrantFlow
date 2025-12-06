import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Database, TrendingUp, CheckCircle, AlertCircle } from 'lucide-react';

/**
 * Display crawl statistics in card format
 */
export default function CrawlStats({ 
  totalOpportunities, 
  availableCrawlers, 
  successfulCrawls, 
  failedCrawls 
}) {
  const stats = [
    {
      label: 'Total Opportunities',
      value: totalOpportunities,
      icon: Database,
      color: 'text-blue-500'
    },
    {
      label: 'Available Crawlers',
      value: availableCrawlers,
      icon: TrendingUp,
      color: 'text-emerald-500'
    },
    {
      label: 'Successful Crawls',
      value: successfulCrawls,
      icon: CheckCircle,
      color: 'text-green-500'
    },
    {
      label: 'Recent Errors',
      value: failedCrawls,
      icon: AlertCircle,
      color: 'text-red-500'
    }
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <Card key={stat.label}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-500">{stat.label}</div>
                  <div className={`text-3xl font-bold mt-1 ${
                    stat.label === 'Recent Errors' ? 'text-red-600' : 
                    stat.label === 'Successful Crawls' ? 'text-green-600' :
                    stat.label === 'Available Crawlers' ? 'text-emerald-600' :
                    'text-slate-900'
                  }`}>
                    {stat.value}
                  </div>
                </div>
                <Icon className={`w-10 h-10 ${stat.color} opacity-50`} />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}