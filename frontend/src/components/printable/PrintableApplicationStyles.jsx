import React from 'react';

/**
 * Print styles for the PrintableApplication component
 * Extracted for maintainability and to avoid dangerouslySetInnerHTML
 */
export default function PrintableApplicationStyles() {
  return (
    <style>
      {`
        @media print {
          .no-print { 
            display: none !important; 
          }
          @page { 
            margin: 0.6in 0.5in;
            size: letter portrait;
          }
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
            overflow: visible !important;
          }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            overflow: visible !important;
          }
          .max-w-4xl {
            max-width: 100% !important;
          }
          .p-8 {
            padding: 0 !important;
          }
          body, p, div, span {
            font-size: 11px !important;
            line-height: 1.3 !important;
          }
          .text-xs {
            font-size: 9px !important;
          }
          .text-sm {
            font-size: 10px !important;
          }
          .ml-4 {
            margin-left: 12px !important;
          }
          .ml-7 {
            margin-left: 20px !important;
          }
          .ml-8 {
            margin-left: 24px !important;
          }
          .mb-1 {
            margin-bottom: 3px !important;
          }
          .mb-2 {
            margin-bottom: 5px !important;
          }
          .mt-2 {
            margin-top: 5px !important;
          }
          .mt-3 {
            margin-top: 8px !important;
          }
          .mt-4 {
            margin-top: 10px !important;
          }
          .pb-3 {
            padding-bottom: 8px !important;
          }
        }
        
        .form-line {
          border-bottom: 1px solid #000;
          min-height: 18px;
          margin-bottom: 5px;
          display: block;
        }
        .form-box {
          border: 1px solid #000;
          padding: 2px;
          min-height: 16px;
          display: inline-block;
          width: 16px;
          margin-right: 6px;
          vertical-align: middle;
        }
        .inline-entry {
          border-bottom: 1px solid #000;
          display: inline-block;
          min-height: 16px;
          vertical-align: baseline;
        }
        .form-section {
          margin-bottom: 16px;
          page-break-inside: auto;
        }
        h1, h2, h3 { 
          font-weight: bold; 
          margin-bottom: 8px;
        }
        h1 { font-size: 20px; }
        h2 { 
          font-size: 15px; 
          margin-top: 16px;
          padding-top: 6px;
        }
        h3 { 
          font-size: 12px; 
          margin-top: 10px; 
        }
        .page-break {
          page-break-after: always;
          break-after: page;
          height: 0;
          margin: 0;
          padding: 0;
        }
        .avoid-break {
          page-break-inside: avoid;
          break-inside: avoid;
        }
      `}
    </style>
  );
}