import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  FileText, 
  ExternalLink, 
  CheckCircle2, 
  AlertCircle,
  Link2,
  Shield,
  Calendar
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function IRSConnectionCard({ organizations = [] }) {
  // Check for organizations with tax-relevant info
  const orgsWithEIN = organizations.filter(org => org.ein);
  const orgsWithSSN = organizations.filter(org => org.ssn);
  const totalTaxProfiles = orgsWithEIN.length + orgsWithSSN.length;

  const irsLinks = [
    {
      title: 'IRS Data Retrieval Tool',
      description: 'Auto-import tax data to FAFSA',
      url: 'https://studentaid.gov/apply-for-aid/fafsa/filling-out/irs-drt',
      icon: Link2
    },
    {
      title: 'Get Transcript Online',
      description: 'Download tax transcripts',
      url: 'https://www.irs.gov/individuals/get-transcript',
      icon: FileText
    },
    {
      title: 'Tax Exempt Status',
      description: 'Check 501(c)(3) status',
      url: 'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search',
      icon: Shield
    },
    {
      title: 'EIN Lookup',
      description: 'Verify employer ID numbers',
      url: 'https://www.irs.gov/businesses/small-businesses-self-employed/employer-id-numbers',
      icon: FileText
    }
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-green-600" />
            IRS Connections
          </span>
          <Link to={createPageUrl('TaxCenter')}>
            <Button variant="outline" size="sm">
              Tax Center
            </Button>
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Profile Tax Status */}
        <div className="p-3 bg-slate-50 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Tax-Ready Profiles</span>
            <Badge variant="outline">{totalTaxProfiles} of {organizations.length}</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center gap-2">
              {orgsWithEIN.length > 0 ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : (
                <AlertCircle className="w-4 h-4 text-slate-400" />
              )}
              <span>{orgsWithEIN.length} with EIN</span>
            </div>
            <div className="flex items-center gap-2">
              {orgsWithSSN.length > 0 ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : (
                <AlertCircle className="w-4 h-4 text-slate-400" />
              )}
              <span>{orgsWithSSN.length} with SSN</span>
            </div>
          </div>
        </div>

        {/* Important Dates */}
        <div className="p-3 bg-blue-50 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-medium text-blue-900">Key Tax Dates</span>
          </div>
          <div className="space-y-1 text-xs text-blue-800">
            <p>• <strong>Jan 29, 2025:</strong> IRS starts accepting returns</p>
            <p>• <strong>Apr 15, 2025:</strong> Individual tax deadline</p>
            <p>• <strong>May 15, 2025:</strong> Nonprofit 990 deadline</p>
          </div>
        </div>

        {/* Quick Links */}
        <div className="space-y-2" role="list" aria-label="IRS quick links">
          {irsLinks.map((link) => (
            <a 
              key={link.title}
              href={link.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center justify-between p-2 bg-white border rounded-lg hover:bg-slate-50 transition-colors"
              aria-label={`${link.title}: ${link.description}`}
            >
              <div className="flex items-center gap-2">
                <link.icon className="w-4 h-4 text-slate-600" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium">{link.title}</p>
                  <p className="text-xs text-slate-500">{link.description}</p>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-slate-400" aria-hidden="true" />
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}