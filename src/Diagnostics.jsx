import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CheckCircle, XCircle, Loader2, PlayCircle, Clock, FileText } from 'lucide-react';

const Diagnostics = () => {
  const [isTesting, setIsTesting] = useState(false);
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState({ ok: 0, fail: 0, totalMs: 0 });
  const [currentTest, setCurrentTest] = useState('');
  
  // NEW: Test file upload and parsing
  const [testFile, setTestFile] = useState(null);
  const [parseResult, setParseResult] = useState(null);
  const [isParsing, setIsParsing] = useState(false);

  const { data: grants, isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants'],
    queryFn: () => base44.entities.Grant.list(),
  });

  const runTests = async () => {
    if (!grants || grants.length === 0) {
      alert("No grants found to test.");
      return;
    }

    setIsTesting(true);
    setResults([]);
    setCurrentTest('');
    setSummary({ ok: 0, fail: 0, totalMs: 0 });
    const startAll = Date.now();
    
    let allResults = [];

    for (const grant of grants) {
      setCurrentTest(`Testing: ${grant.title}`);
      
      const payload = {
        grantId: grant.id,
        title: grant.title,
        deadline: grant.deadline,
        awardCeiling: grant.award_ceiling,
        description: grant.program_description,
        eligibility: grant.eligibility_summary,
        selectionCriteria: grant.selection_criteria,
      };

      const t0 = Date.now();
      let testResult;

      try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout: Function took longer than 30 seconds to respond.')), 30000)
        );

        const response = await Promise.race([
            base44.functions.invoke('analyzeGrant', payload),
            timeoutPromise
        ]);

        const ms = Date.now() - t0;
        
        // FIX: Check for success instead of jobId
        if (response.data?.success) {
          testResult = {
            title: grant.title,
            status: 'ok',
            message: `Success (${ms} ms) - Analysis complete`,
            warnings: [],
          };
          setSummary(prev => ({ ...prev, ok: prev.ok + 1 }));
        } else {
          testResult = {
            title: grant.title,
            status: 'fail',
            message: `Failed - ${response.data?.message || response.data?.error || 'Unknown analysis error'}`,
          };
          setSummary(prev => ({ ...prev, fail: prev.fail + 1 }));
        }
      } catch (e) {
        const ms = Date.now() - t0;
        const errorMessage = e.message || 'Network or execution error';
        testResult = {
          title: grant.title,
          status: 'fail',
          message: `Request failed (${ms} ms): ${errorMessage}`,
        };
        setSummary(prev => ({ ...prev, fail: prev.fail + 1 }));
      }
      
      allResults.push(testResult);
      setResults([...allResults]);
    }
    const totalMs = Date.now() - startAll;
    setSummary(prev => ({ ...prev, totalMs }));
    setCurrentTest('');
    setIsTesting(false);
  };
  
  const testFileParsing = async () => {
    if (!testFile) {
      alert('Please select a file first');
      return;
    }
    
    setIsParsing(true);
    setParseResult(null);
    
    try {
      // Upload file
      const { file_url } = await base44.integrations.Core.UploadFile({ file: testFile });
      
      // Try to parse it
      const response = await base44.functions.invoke('parseNOFO', {
        file_url,
        json_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            funder: { type: "string" }
          }
        }
      });
      
      setParseResult({
        status: 'success',
        data: response.data
      });
      
    } catch (error) {
      setParseResult({
        status: 'error',
        message: error.message,
        details: error.response?.data
      });
    } finally {
      setIsParsing(false);
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto space-y-6">
      <Card className="shadow-lg border-0">
        <CardHeader>
          <CardTitle>AI Proposal Coach Diagnostic</CardTitle>
          <CardDescription>
            This tool tests the AI analysis endpoint against every grant in the system to ensure connectivity, performance, and resilience.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Button onClick={runTests} disabled={isTesting || isLoadingGrants} className="w-64">
              {isTesting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Run Analysis Test ({grants?.length || 0} Grants)
                </>
              )}
            </Button>
            {isTesting && currentTest && (
                <p className="text-sm text-slate-500 truncate">{currentTest}</p>
            )}
          </div>
          
          {results.length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-lg mb-2">Test Results</h3>
              <div className="p-4 bg-slate-100 rounded-lg max-h-96 overflow-y-auto font-mono text-sm space-y-1">
                {results.map((result, index) => (
                  <div key={index} className="flex items-start gap-2">
                    {result.status === 'ok' ? (
                      <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      result.message.includes('Timeout') ? 
                        <Clock className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" /> :
                        <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    )}
                    <span className={result.status === 'fail' ? (result.message.includes('Timeout') ? 'text-amber-600' : 'text-red-600') : ''}>
                      <strong>{result.title}:</strong> {result.message}
                    </span>
                  </div>
                ))}
              </div>
              {!isTesting && (
                 <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-800">
                    <strong>Diagnostic Complete:</strong> {summary.ok} passed / {summary.fail} failed in {(summary.totalMs / 1000).toFixed(2)}s
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      
      <Card className="shadow-lg border-0">
        <CardHeader>
          <CardTitle>NOFO Parser Test</CardTitle>
          <CardDescription>
            Test the document parsing function with a real file to diagnose issues.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Input 
              type="file" 
              accept=".pdf,.doc,.docx"
              onChange={(e) => setTestFile(e.target.files[0])}
            />
          </div>
          
          <Button onClick={testFileParsing} disabled={!testFile || isParsing}>
            {isParsing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Parsing...
              </>
            ) : (
              <>
                <FileText className="mr-2 h-4 w-4" />
                Test Parse File
              </>
            )}
          </Button>
          
          {parseResult && (
            <div className={`mt-4 p-4 rounded-lg border ${
              parseResult.status === 'success' 
                ? 'bg-green-50 border-green-200' 
                : 'bg-red-50 border-red-200'
            }`}>
              <h4 className="font-semibold mb-2">
                {parseResult.status === 'success' ? '✓ Success' : '✗ Failed'}
              </h4>
              <pre className="text-xs overflow-auto max-h-64 bg-white p-2 rounded">
                {JSON.stringify(parseResult, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Diagnostics;