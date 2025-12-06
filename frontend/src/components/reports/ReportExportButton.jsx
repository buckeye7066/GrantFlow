import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, FileText, FileSpreadsheet } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from '@/components/ui/use-toast';

/**
 * Report Export Button - Quick export dropdown for any report
 */
export default function ReportExportButton({ 
  data, 
  filename = 'report',
  fields = [],
  title = 'Report'
}) {
  const { toast } = useToast();

  const exportToCSV = () => {
    if (!data || data.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No Data',
        description: 'No data available to export',
      });
      return;
    }

    const headers = fields.map(f => f.label || f.value);
    const rows = data.map(item => 
      fields.map(f => {
        const value = item[f.value];
        if (typeof value === 'object' && value !== null) {
          return JSON.stringify(value);
        }
        return value || '';
      })
    );

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: '✅ CSV Downloaded',
      description: `${data.length} records exported`,
    });
  };

  const exportToPDF = () => {
    if (!data || data.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No Data',
        description: 'No data available to export',
      });
      return;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; }
          h1 { color: #1e293b; margin-bottom: 10px; }
          .meta { color: #64748b; margin-bottom: 30px; font-size: 14px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th { background: #f1f5f9; padding: 12px; text-align: left; border-bottom: 2px solid #cbd5e1; font-size: 12px; }
          td { padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 11px; }
          tr:nth-child(even) { background: #f8fafc; }
          .footer { margin-top: 40px; color: #94a3b8; font-size: 10px; text-align: center; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        <div class="meta">
          <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Total Records:</strong> ${data.length}</p>
        </div>
        <table>
          <thead>
            <tr>
              ${fields.map(f => `<th>${f.label || f.value}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${data.map(item => `
              <tr>
                ${fields.map(f => {
                  let value = item[f.value];
                  if (typeof value === 'object' && value !== null) {
                    value = JSON.stringify(value);
                  }
                  return `<td>${value || ''}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div class="footer">
          <p>GrantFlow - Grant Management System</p>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    
    setTimeout(() => {
      printWindow.print();
    }, 250);

    toast({
      title: '📄 PDF Ready',
      description: 'Report opened for printing/saving',
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-2" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={exportToCSV}>
          <FileSpreadsheet className="w-4 h-4 mr-2" />
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportToPDF}>
          <FileText className="w-4 h-4 mr-2" />
          Export as PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}