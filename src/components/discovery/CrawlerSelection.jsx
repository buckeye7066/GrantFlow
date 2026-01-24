import React, { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  MapPin, Building2, GraduationCap, Heart, 
  Package, Users, Loader2, CheckCircle, Info, AlertTriangle
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { apiFetch } from '@/api/client';
import { createLogger } from '@/utils/logger'

const CRAWLER_CONFIGS = [
  {
    id: 'local_funding',
    name: 'Local Funding',
    icon: MapPin,
    description: 'Searches for funding opportunities within 50 miles of your location or school ZIP code',
    details: 'Includes community foundations, United Way, local nonprofits, and regional grant programs. Excludes loans and matching funds.',
    color: 'text-blue-600'
  },
  {
    id: 'government_funding',
    name: 'Government Funding',
    icon: Building2,
    description: 'Federal, state, and local government grants including NIH, FEMA, Medicare/Medicaid',
    details: 'Searches Grants.gov, state grant databases, and federal agency programs. Includes healthcare funding through CMS.',
    color: 'text-purple-600'
  },
  {
    id: 'student_grants',
    name: 'Student Grants & Scholarships',
    icon: GraduationCap,
    description: 'FAFSA, CommonApp, scholarships, and school-specific financial aid',
    details: 'Matches based on GPA, test scores, interests, and accomplishments. Includes need-based and merit-based aid.',
    color: 'text-green-600'
  },
  {
    id: 'ecf_benefits',
    name: 'ECF CHOICES Benefits',
    icon: Heart,
    description: 'Benefits for ECF CHOICES participants and support providers',
    details: 'Two branches: Individual benefits for participants and funding for family model CLS-FM homes and support services.',
    color: 'text-pink-600'
  },
  {
    id: 'item_matching',
    name: 'Item-Specific Funding',
    icon: Package,
    description: 'Finds funding for specific items like vehicles, equipment, or supplies',
    details: 'Matches both the item request and profile criteria. Example: 15-passenger van for mission-minded nonprofit.',
    color: 'text-orange-600'
  },
  {
    id: 'special_needs',
    name: 'Special Needs Funding',
    icon: Users,
    description: 'Funding for specific populations: cancer survivors, single parents, disabled individuals',
    details: 'Searches specialized foundations and programs focused on particular health conditions or life circumstances.',
    color: 'text-indigo-600'
  }
];

export default function CrawlerSelection({ 
  profileId, 
  profileData,
  onCrawlComplete,
  itemRequest = null 
}) {
  const [selectedCrawlers, setSelectedCrawlers] = useState(new Set());
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({});
  const [results, setResults] = useState({});
  const [errors, setErrors] = useState({});
  const [minMatchScore, setMinMatchScore] = useState(50); // Lowered to 50 to show more results; crawlers now use 100% of profile signals for scoring
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('CrawlerSelection'), [])

  const handleToggleCrawler = (crawlerId) => {
    setSelectedCrawlers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(crawlerId)) {
        newSet.delete(crawlerId);
      } else {
        newSet.add(crawlerId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedCrawlers.size === CRAWLER_CONFIGS.length) {
      setSelectedCrawlers(new Set());
    } else {
      setSelectedCrawlers(new Set(CRAWLER_CONFIGS.map(c => c.id)));
    }
  };

  const handleRunCrawlers = async () => {
    if (selectedCrawlers.size === 0) {
      toast({
        variant: 'destructive',
        title: 'No crawlers selected',
        description: 'Please select at least one crawler to run'
      });
      return;
    }

    setIsRunning(true);
    setProgress({});
    setResults({});
    setErrors({});

    const crawlersToRun = Array.from(selectedCrawlers);
    log.debug('running crawlers', { count: crawlersToRun.length, profileId })

    // Initialize progress
    crawlersToRun.forEach(id => {
      setProgress(prev => ({ ...prev, [id]: 'running' }));
    });

    // Run crawlers in parallel
    const crawlerPromises = crawlersToRun.map(async (crawlerId) => {
      try {
        // Call the crawler API with authenticated request
        const data = await apiFetch('/api/real-crawlers/run', {
          method: 'POST',
          body: JSON.stringify({
            crawler_type: crawlerId,
            profile_id: profileId,
            profile_data: profileData,
            item_request: itemRequest,
            min_match_score: minMatchScore
          })
        });

        // Treat backend-reported failure as an error (even though HTTP is 200)
        if (data && data.success === false) {
          const message = data.message || data.error || 'Crawler failed'
          const err = new Error(message)
          err.response = data
          throw err
        }
        
        setProgress(prev => ({ ...prev, [crawlerId]: 'completed' }));
        setResults(prev => ({ ...prev, [crawlerId]: data }));
        
        return { crawlerId, success: true, data };
      } catch (error) {
        console.error(`[CrawlerSelection] Error running ${crawlerId}:`, error);
        setProgress(prev => ({ ...prev, [crawlerId]: 'error' }));
        
        // Extract meaningful error message
        let errorMessage = error.message || 'Unknown error';
        
        // Try to get more specific error from the response
        if (error.response && typeof error.response === 'object') {
          errorMessage = error.response.error || error.response.message || errorMessage;
        }
        
        // Store the error message for display
        setErrors(prev => ({ ...prev, [crawlerId]: errorMessage }));
        
        return { crawlerId, success: false, error: errorMessage };
      }
    });

    const allResults = await Promise.all(crawlerPromises);
    
    // Combine all successful results
    const successfulResults = allResults
      .filter(r => r.success)
      .flatMap(r => r.data.opportunities || []);

    const failedResults = allResults.filter(r => !r.success);

    log.debug('crawler results', { opportunities: successfulResults.length, minMatchScore })

    // Add to pipeline if callback provided
    if (onCrawlComplete && successfulResults.length > 0) {
      await onCrawlComplete(successfulResults);
    }

    setIsRunning(false);

    // Show completion toast with detailed error info
    const successCount = allResults.filter(r => r.success).length;
    const errorCount = allResults.filter(r => !r.success).length;

    let toastDescription = `${successCount} succeeded, ${errorCount} failed. Found ${successfulResults.length} opportunities.`;
    
    // Add error details if any failed
    if (failedResults.length > 0) {
      const errorDetails = failedResults
        .map(r => {
          const crawlerName = CRAWLER_CONFIGS.find(c => c.id === r.crawlerId)?.name || r.crawlerId;
          return `${crawlerName}: ${r.error}`;
        })
        .join('\n');
      
      toastDescription += `\n\nErrors:\n${errorDetails}`;
    }

    toast({
      title: 'Crawler run complete',
      description: toastDescription,
      variant: errorCount > 0 ? 'destructive' : 'default'
    });
  };

  const allSelected = selectedCrawlers.size === CRAWLER_CONFIGS.length;
  const someSelected = selectedCrawlers.size > 0;
  const anyDbFallback = Object.values(results || {}).some((r) => r && r.used_db_fallback);
  const missingZipLikely = Object.values(results || {}).some((r) => r?.debug && r.debug.has_zip === false);
  const lowKeywordsLikely = Object.values(results || {}).some((r) => r?.debug && (r.debug.keyword_count ?? 0) < 5);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="w-5 h-5" />
            Select Funding Crawlers
          </CardTitle>
          <CardDescription>
            Choose which specialized crawlers to run for finding funding opportunities
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {anyDbFallback && (
            <Alert variant="warning">
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription>
                Some crawlers returned <strong>DB fallback</strong> results (real opportunities from your local curated database)
                because the live crawl returned nothing or your profile is missing key signals.
                {missingZipLikely && (
                  <>
                    <br />
                    <span className="text-sm">Tip: add a ZIP/state to get true local matches.</span>
                  </>
                )}
                {lowKeywordsLikely && (
                  <>
                    <br />
                    <span className="text-sm">Tip: add a few tags/keywords to improve match quality.</span>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
          {/* Match score threshold */}
          <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-900">Minimum match score</div>
                <div className="text-xs text-slate-600">
                  Lower this to see more results; raise it to keep only the strongest matches.
                </div>
              </div>
              <div className="text-sm font-semibold text-slate-900">{minMatchScore}%</div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minMatchScore}
              onChange={(e) => setMinMatchScore(Number(e.target.value))}
              disabled={isRunning}
              className="mt-3 w-full"
            />
          </div>

          {/* Select All Control */}
          <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
            <div className="flex items-center gap-3">
              <Checkbox
                id="select-all-crawlers"
                checked={allSelected}
                onCheckedChange={handleSelectAll}
              />
              <label 
                htmlFor="select-all-crawlers" 
                className="font-medium cursor-pointer"
              >
                {allSelected ? 'Deselect All' : 'Select All Crawlers'}
              </label>
            </div>
            {someSelected && (
              <span className="text-sm text-slate-600">
                {selectedCrawlers.size} crawler{selectedCrawlers.size !== 1 ? 's' : ''} selected
              </span>
            )}
          </div>

          {/* Crawler Options */}
          <div className="grid gap-4 md:grid-cols-2">
            {CRAWLER_CONFIGS.map((crawler) => {
              const Icon = crawler.icon;
              const isSelected = selectedCrawlers.has(crawler.id);
              const status = progress[crawler.id];
              const result = results[crawler.id];
              const error = errors[crawler.id];

              return (
                <div
                  key={crawler.id}
                  className={`
                    relative border rounded-lg p-4 transition-all cursor-pointer
                    ${isSelected ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-slate-300'}
                    ${status === 'running' ? 'opacity-75' : ''}
                    ${status === 'completed' ? 'border-green-500 bg-green-50/30' : ''}
                    ${status === 'error' ? 'border-red-500 bg-red-50/30' : ''}
                  `}
                  onClick={() => !isRunning && handleToggleCrawler(crawler.id)}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => handleToggleCrawler(crawler.id)}
                      disabled={isRunning}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1"
                    />
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <Icon className={`w-5 h-5 ${crawler.color}`} />
                        <h3 className="font-semibold">{crawler.name}</h3>
                        {status === 'running' && (
                          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                        )}
                        {status === 'completed' && (
                          <CheckCircle className="w-4 h-4 text-green-600" />
                        )}
                        {status === 'error' && (
                          <AlertTriangle className="w-4 h-4 text-red-600" />
                        )}
                      </div>
                      <p className="text-sm text-slate-700">{crawler.description}</p>
                      <p className="text-xs text-slate-500">{crawler.details}</p>
                      
                      {result && (
                        <div className="mt-2 text-xs text-green-700 font-medium">
                          Included {result.count || 0} of {result.total_found ?? (result.count || 0)} found
                        </div>
                      )}
                      
                      {error && (
                        <div className="mt-2 p-2 bg-red-100 border border-red-300 rounded text-xs text-red-800">
                          <strong>Error:</strong> {error}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Item Request Alert */}
          {itemRequest && (
            <Alert>
              <Package className="w-4 h-4" />
              <AlertDescription>
                <strong>Item Request:</strong> {itemRequest}
                <br />
                <span className="text-sm">
                  Item-specific crawler will search for funding matching both this item and your profile.
                </span>
              </AlertDescription>
            </Alert>
          )}

          {/* Run Button */}
          <div className="flex justify-end pt-4 border-t">
            <Button
              onClick={handleRunCrawlers}
              disabled={!someSelected || isRunning}
              size="lg"
              className="min-w-[200px]"
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Running Crawlers...
                </>
              ) : (
                <>
                  Run Selected Crawlers
                  {someSelected && ` (${selectedCrawlers.size})`}
                </>
              )}
            </Button>
          </div>

          {/* Results Summary */}
          {Object.keys(results).length > 0 && (
            <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <h4 className="font-semibold text-green-900 mb-2">Crawler Results</h4>
              <div className="space-y-1">
                {Object.entries(results).map(([crawlerId, result]) => {
                  const crawler = CRAWLER_CONFIGS.find(c => c.id === crawlerId);
                  return (
                    <div key={crawlerId} className="text-sm text-green-800">
                      <span className="font-medium">{crawler?.name}:</span>{' '}
                      {result.count || 0} included of {result.total_found ?? (result.count || 0)} found
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}