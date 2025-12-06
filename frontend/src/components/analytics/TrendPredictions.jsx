import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, AreaChart } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import { format, startOfMonth, parseISO, addMonths } from 'date-fns';

export default function TrendPredictions({ grants }) {
  const predictions = useMemo(() => {
    const monthlyData = {};
    
    grants.forEach(grant => {
      const month = format(startOfMonth(parseISO(grant.created_date)), 'yyyy-MM');
      monthlyData[month] = (monthlyData[month] || 0) + 1;
    });

    const historical = Object.entries(monthlyData)
      .map(([month, count]) => ({
        month: format(parseISO(`${month}-01`), 'MMM yyyy'),
        actual: count,
        type: 'historical'
      }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    if (historical.length < 3) {
      return { chartData: historical, trend: 'insufficient', avgGrowth: 0, prediction: null };
    }

    const values = historical.map(h => h.actual);
    const avgGrowth = values.reduce((sum, val, idx) => {
      if (idx === 0) return sum;
      return sum + ((val - values[idx - 1]) / values[idx - 1]);
    }, 0) / (values.length - 1);

    const lastMonth = historical[historical.length - 1];
    const lastValue = lastMonth.actual;

    const futureMonths = [];
    for (let i = 1; i <= 3; i++) {
      const futureDate = addMonths(new Date(), i);
      const predicted = Math.max(0, Math.round(lastValue * Math.pow(1 + avgGrowth, i)));
      futureMonths.push({
        month: format(futureDate, 'MMM yyyy'),
        predicted,
        type: 'predicted'
      });
    }

    const chartData = [...historical, ...futureMonths];
    
    const trend = avgGrowth > 0.05 ? 'increasing' : avgGrowth < -0.05 ? 'decreasing' : 'stable';

    return { chartData, trend, avgGrowth: (avgGrowth * 100).toFixed(1), prediction: futureMonths };
  }, [grants]);

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">Trend Direction</p>
                <div className="flex items-center gap-2 mt-2">
                  {predictions.trend === 'increasing' && (
                    <>
                      <TrendingUp className="w-5 h-5 text-green-600" />
                      <Badge className="bg-green-100 text-green-800">Growing</Badge>
                    </>
                  )}
                  {predictions.trend === 'decreasing' && (
                    <>
                      <TrendingDown className="w-5 h-5 text-red-600" />
                      <Badge className="bg-red-100 text-red-800">Declining</Badge>
                    </>
                  )}
                  {predictions.trend === 'stable' && (
                    <>
                      <TrendingUp className="w-5 h-5 text-blue-600" />
                      <Badge className="bg-blue-100 text-blue-800">Stable</Badge>
                    </>
                  )}
                  {predictions.trend === 'insufficient' && (
                    <>
                      <AlertCircle className="w-5 h-5 text-slate-400" />
                      <Badge variant="outline">Insufficient Data</Badge>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm font-medium text-slate-600">Avg. Monthly Growth</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {predictions.avgGrowth}%
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm font-medium text-slate-600">Next Month Prediction</p>
              <p className="text-3xl font-bold text-blue-600 mt-2">
                {predictions.prediction?.[0]?.predicted || 'N/A'}
              </p>
              <p className="text-xs text-slate-500">grants expected</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Historical Data & Predictions</CardTitle>
          <CardDescription>
            Grant application trends with 3-month forecast based on historical patterns
          </CardDescription>
        </CardHeader>
        <CardContent>
          {predictions.chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={predictions.chartData}>
                <defs>
                  <linearGradient id="colorActual" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorPredicted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.6}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Area 
                  type="monotone" 
                  dataKey="actual" 
                  stroke="#3b82f6" 
                  fillOpacity={1}
                  fill="url(#colorActual)"
                  name="Historical"
                />
                <Area 
                  type="monotone" 
                  dataKey="predicted" 
                  stroke="#10b981" 
                  strokeDasharray="5 5"
                  fillOpacity={1}
                  fill="url(#colorPredicted)"
                  name="Predicted"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[400px] flex items-center justify-center text-slate-500">
              Insufficient data for predictions (need at least 3 months of history)
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-semibold text-blue-900">About These Predictions</p>
              <p className="text-sm text-blue-800 mt-1">
                Predictions are based on historical growth patterns and assume similar conditions will continue. 
                Actual results may vary due to external factors, seasonal trends, and changes in strategy.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}