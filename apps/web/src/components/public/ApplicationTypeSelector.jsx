import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ArrowRight, DollarSign } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

// Application types with pricing
const APPLICATION_TYPES = [
  {
    id: 'basic_profile',
    name: 'Basic Profile Setup',
    description: 'Initial profile creation and basic grant research',
    monthlyFee: 149,
    oneTime: true
  },
  {
    id: 'private_foundation',
    name: 'Private Foundation Grant',
    description: 'Application to private foundation (typically 5-10 pages)',
    monthlyFee: 600,
    range: [600, 1200]
  },
  {
    id: 'corporate_grant',
    name: 'Corporate Grant',
    description: 'Corporate giving application with alignment documentation',
    monthlyFee: 800,
    range: [800, 1500]
  },
  {
    id: 'federal_grant',
    name: 'Federal Grant Application',
    description: 'Complex federal application (HHS, NIH, DOJ, etc.)',
    monthlyFee: 2500,
    range: [2500, 8000]
  },
  {
    id: 'state_local',
    name: 'State / Local Grant',
    description: 'State or municipal grant application',
    monthlyFee: 1200,
    range: [1200, 3000]
  },
  {
    id: 'nonprofit_formation',
    name: 'Nonprofit Formation (501(c)(3))',
    description: 'Complete IRS 1023 application and state incorporation',
    monthlyFee: 3500,
    oneTime: true
  },
  {
    id: 'complex_multi',
    name: 'Complex Multi-Partner Application',
    description: 'Multi-agency or collaborative grant with multiple partners',
    monthlyFee: 5000,
    range: [5000, 12000]
  },
  {
    id: 'scholarship',
    name: 'Scholarship Application',
    description: 'Student scholarship application assistance',
    monthlyFee: 199,
    range: [99, 299]
  },
  {
    id: 'other',
    name: 'Other / Custom',
    description: 'Custom application support - pricing determined after consultation',
    monthlyFee: 0,
    custom: true
  }
];

export default function ApplicationTypeSelector({ selectedTypes, onToggle, onNext }) {
  const totalMonthly = selectedTypes.reduce((sum, typeId) => {
    const type = APPLICATION_TYPES.find(t => t.id === typeId);
    return sum + (type?.monthlyFee || 0);
  }, 0);

  const hasSelection = selectedTypes.length > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Select Application Type(s)</CardTitle>
          <CardDescription>
            Choose the type(s) of applications you need assistance with. 
            You can select multiple options. Costs will be calculated in real-time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {APPLICATION_TYPES.map((type) => (
            <div
              key={type.id}
              className={`p-4 rounded-lg border-2 transition-all cursor-pointer hover:bg-slate-50 ${
                selectedTypes.includes(type.id)
                  ? 'border-blue-600 bg-blue-50'
                  : 'border-slate-200'
              }`}
              onClick={() => onToggle(type.id)}
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={selectedTypes.includes(type.id)}
                  onCheckedChange={() => onToggle(type.id)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <h3 className="font-semibold text-slate-900 mb-1">{type.name}</h3>
                  <p className="text-sm text-slate-600 mb-2">{type.description}</p>
                  <div className="flex items-center gap-2">
                    {type.custom ? (
                      <span className="text-sm font-medium text-slate-700">
                        Custom pricing - determined after consultation
                      </span>
                    ) : (
                      <>
                        <DollarSign className="w-4 h-4 text-green-600" />
                        {type.range ? (
                          <span className="text-sm font-medium text-slate-900">
                            ${type.range[0].toLocaleString()} - ${type.range[1].toLocaleString()}
                            {type.oneTime ? ' (one-time)' : '/month'}
                          </span>
                        ) : (
                          <span className="text-sm font-medium text-slate-900">
                            ${type.monthlyFee.toLocaleString()}{type.oneTime ? ' (one-time)' : '/month'}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Running Total */}
      {hasSelection && (
        <Card className="border-2 border-green-600 bg-green-50">
          <CardContent className="p-6">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Estimated Monthly Cost
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  {selectedTypes.length} application type(s) selected
                </p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-green-700">
                  ${totalMonthly.toLocaleString()}
                </div>
                <p className="text-sm text-slate-600">per month</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Note about custom pricing */}
      {selectedTypes.includes('other') && (
        <Alert>
          <AlertDescription>
            <strong>Note:</strong> Custom application pricing will be determined after an initial consultation 
            to understand your specific needs and complexity.
          </AlertDescription>
        </Alert>
      )}

      {/* Continue Button */}
      <div className="flex justify-end">
        <Button
          onClick={onNext}
          disabled={!hasSelection}
          size="lg"
          className="bg-blue-600 hover:bg-blue-700"
        >
          Continue to Application Form
          <ArrowRight className="w-5 h-5 ml-2" />
        </Button>
      </div>
    </div>
  );
}

export { APPLICATION_TYPES };