import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { format, startOfMonth, parseISO } from 'date-fns';

export default function SuccessRateChart({ grants }) {
  const chartData = useMemo(() => {
    const monthlyData = {};

    grants.forEach(grant => {
      const month = format(startOfMonth(parseISO(grant.created_date)), 'MMM yyyy');
      
      if (!monthlyData[month]) {
        monthlyData[month] = {
          month,
          submitted: 0,
          awarded: 0,
          declined: 0,
          total: 0
        };
      }

      monthlyData[month].total++;
      
      if (grant.status === 'submitted' || grant.status === 'awarded' || grant.status === 'declined') {
        monthlyData[month].submitted++;
      }
      if (grant.status === 'awarded') {
        monthlyData[month].awarded++;
      }
      if (grant.status === 'declined') {
        monthlyData[month].declined++;
      }
    });

    return Object.values(monthlyData)
      .map(data => ({
        ...data,
        successRate: data.submitted > 0 
          ? ((data.awarded / (data.awarded + data.declined)) * 100).toFixed(1)
          : 0
      }))
      .slice(-12);
  }, [grants]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Success Rate Over Time</CardTitle>
        <CardDescription>
          Monthly success rate for submitted grant applications
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line 
              type="monotone" 
              dataKey="successRate" 
              stroke="#10b981" 
              strokeWidth={3}
              name="Success Rate (%)"
            />
            <Line 
              type="monotone" 
              dataKey="awarded" 
              stroke="#3b82f6" 
              name="Awarded"
            />
            <Line 
              type="monotone" 
              dataKey="declined" 
              stroke="#ef4444" 
              name="Declined"
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}