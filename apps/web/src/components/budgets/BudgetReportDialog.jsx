import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Download, FileText, CheckSquare } from 'lucide-react';
import { formatDateSafe } from '@/components/shared/dateUtils';
import { useToast } from '@/components/ui/use-toast';

const CATEGORY_LABELS = {
  personnel: 'Personnel',
  fringe: 'Fringe Benefits',
  travel: 'Travel',
  equipment: 'Equipment',
  supplies: 'Supplies',
  contractual: 'Contractual',
  construction: 'Construction',
  other_direct: 'Other Direct Costs',
  indirect: 'Indirect Costs'
};

export default function BudgetReportDialog({ 
  open, 
  onClose, 
  grant, 
  budgetItems = [], 
  expenses = [],
  summary 
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();

  const generatePDFReport = () => {
    setIsGenerating(true);
    
    try {
      // Create printable content
      const reportContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Budget Report - ${grant.title}</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              margin: 40px; 
              color: #1e293b;
            }
            h1 { 
              color: #0f172a; 
              border-bottom: 3px solid #3b82f6; 
              padding-bottom: 10px;
              margin-bottom: 20px;
            }
            h2 { 
              color: #334155; 
              margin-top: 30px;
              margin-bottom: 15px;
              border-bottom: 1px solid #e2e8f0;
              padding-bottom: 8px;
            }
            .summary-grid {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 20px;
              margin: 30px 0;
            }
            .summary-card {
              background: #f8fafc;
              padding: 20px;
              border-radius: 8px;
              border: 1px solid #e2e8f0;
            }
            .summary-label {
              font-size: 12px;
              color: #64748b;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              margin-bottom: 5px;
            }
            .summary-value {
              font-size: 28px;
              font-weight: bold;
              color: #0f172a;
            }
            table { 
              width: 100%; 
              border-collapse: collapse; 
              margin: 20px 0;
            }
            th { 
              background: #f1f5f9; 
              text-align: left; 
              padding: 12px; 
              font-weight: 600;
              border-bottom: 2px solid #cbd5e1;
            }
            td { 
              padding: 10px 12px; 
              border-bottom: 1px solid #e2e8f0;
            }
            tr:hover { background: #f8fafc; }
            .text-right { text-align: right; }
            .over-budget { color: #dc2626; font-weight: bold; }
            .under-budget { color: #059669; font-weight: bold; }
            .meta-info {
              background: #f8fafc;
              padding: 15px;
              border-left: 4px solid #3b82f6;
              margin-bottom: 30px;
            }
            .footer {
              margin-top: 50px;
              padding-top: 20px;
              border-top: 2px solid #e2e8f0;
              text-align: center;
              color: #64748b;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <h1>📊 Budget Report: ${grant.title}</h1>
          
          <div class="meta-info">
            <p><strong>Funder:</strong> ${grant.funder || 'N/A'}</p>
            <p><strong>Grant Deadline:</strong> ${formatDateSafe(grant.deadline)}</p>
            <p><strong>Report Generated:</strong> ${formatDateSafe(new Date(), 'PPP')}</p>
          </div>

          <div class="summary-grid">
            <div class="summary-card">
              <div class="summary-label">Total Planned</div>
              <div class="summary-value">$${summary.totalPlanned.toLocaleString()}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Total Spent</div>
              <div class="summary-value">$${summary.totalSpent.toLocaleString()}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Variance</div>
              <div class="summary-value ${summary.variance < 0 ? 'over-budget' : 'under-budget'}">
                $${Math.abs(summary.variance).toLocaleString()}
              </div>
              <p style="font-size: 12px; margin-top: 5px; color: #64748b;">
                ${summary.variance < 0 ? 'Over' : 'Under'} budget by ${Math.abs(summary.variancePercent).toFixed(1)}%
              </p>
            </div>
          </div>

          <h2>Budget Breakdown by Category</h2>
          ${Object.entries(summary.categories).map(([category, data]) => {
            const planned = data.planned || 0;
            const spent = data.spent || 0;
            const variance = planned - spent;
            
            return `
              <div style="margin-bottom: 40px;">
                <h3 style="color: #475569; margin-bottom: 15px;">
                  ${CATEGORY_LABELS[category] || category}
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>Line Item</th>
                      <th class="text-right">Quantity</th>
                      <th class="text-right">Unit Cost</th>
                      <th class="text-right">Planned</th>
                      <th class="text-right">Spent</th>
                      <th class="text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${(data.items || []).map(item => {
                      const itemVariance = (item.total || 0) - (item.actual_spent || 0);
                      return `
                        <tr>
                          <td>
                            ${item.line_item}
                            ${item.justification ? `<br><small style="color: #64748b;">${item.justification}</small>` : ''}
                          </td>
                          <td class="text-right">${item.quantity || '-'}</td>
                          <td class="text-right">${item.unit_cost ? '$' + item.unit_cost.toLocaleString() : '-'}</td>
                          <td class="text-right">$${(item.total || 0).toLocaleString()}</td>
                          <td class="text-right">$${(item.actual_spent || 0).toLocaleString()}</td>
                          <td class="text-right ${itemVariance < 0 ? 'over-budget' : 'under-budget'}">
                            ${itemVariance < 0 ? '+' : ''}$${Math.abs(itemVariance).toLocaleString()}
                          </td>
                        </tr>
                      `;
                    }).join('')}
                    <tr style="background: #f1f5f9; font-weight: bold;">
                      <td colspan="3">Category Total</td>
                      <td class="text-right">$${planned.toLocaleString()}</td>
                      <td class="text-right">$${spent.toLocaleString()}</td>
                      <td class="text-right ${variance < 0 ? 'over-budget' : 'under-budget'}">
                        ${variance < 0 ? '+' : ''}$${Math.abs(variance).toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            `;
          }).join('')}

          <div class="footer">
            <p>Generated by GrantFlow Budget Management System</p>
            <p>Report Date: ${new Date().toLocaleString()}</p>
          </div>
        </body>
        </html>
      `;

      // Open in new window and trigger print
      const printWindow = window.open('', '_blank');
      printWindow.document.write(reportContent);
      printWindow.document.close();
      
      setTimeout(() => {
        printWindow.print();
      }, 500);

      toast({
        title: '📄 Report Generated',
        description: 'Budget report opened in new window. Use browser print to save as PDF.',
      });
      
    } catch (error) {
      console.error('[BudgetReport] Generation failed:', error);
      toast({
        variant: 'destructive',
        title: 'Report Generation Failed',
        description: error.message || 'Failed to generate budget report',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate Budget Report</DialogTitle>
          <DialogDescription>
            Create a comprehensive budget report showing planned vs actual spending
          </DialogDescription>
        </DialogHeader>

        <Card className="bg-slate-50">
          <CardContent className="p-6">
            <h4 className="font-semibold text-slate-900 mb-4">Report Preview</h4>
            
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-blue-600" />
                <span>Budget summary with total planned, spent, and variance</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-blue-600" />
                <span>Category breakdown with detailed line items</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-blue-600" />
                <span>Visual progress indicators and variance analysis</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-blue-600" />
                <span>Professional formatting ready for stakeholders</span>
              </div>
            </div>

            <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-900">
                <strong>Report includes:</strong> {budgetItems.length} budget items, 
                {Object.keys(summary.categories).length} categories, 
                ${summary.totalPlanned.toLocaleString()} total planned budget
              </p>
            </div>
          </CardContent>
        </Card>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            onClick={generatePDFReport} 
            disabled={isGenerating || budgetItems.length === 0}
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                Generate Report
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}