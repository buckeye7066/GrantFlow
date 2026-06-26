import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Edit, Trash2, Play, CheckCircle, XCircle, Activity, Sparkles, Wand2, ExternalLink, Clock, HelpCircle } from 'lucide-react';
import { formatDistanceToNow, isValid } from 'date-fns';
import { useToast } from "@/components/ui/use-toast";

// Safely normalize a URL, preferring https. Returns '' on failure.
const normalizeUrl = (rawUrl) => {
  try {
    if (!rawUrl) return '';
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') return parsed.href;
    if (parsed.protocol === 'http:') {
      // Prefer https; upgrade http to https when possible.
      parsed.protocol = 'https:';
      return parsed.href;
    }
    return '';
  } catch (err) {
    console.warn('normalizeUrl: failed to parse URL', rawUrl, err);
    return '';
  }
};

const isValidEmail = (email) => !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Safely format a date value, returning a fallback when invalid.
const safeDistanceToNow = (value, fallback = 'Unknown') => {
  if (!value) return fallback;
  const d = new Date(value);
  if (!isValid(d)) return fallback;
  try {
    return `${formatDistanceToNow(d)} ago`;
  } catch (err) {
    console.warn('safeDistanceToNow: failed to format date', value, err);
    return fallback;
  }
};

const normalizeName = (name) => (name || '').trim().toLowerCase();

const PartnerForm = ({ partner, onSave, onCancel }) => {
  const [formData, setFormData] = useState({
    name: partner?.name ?? '',
    api_base_url: partner?.api_base_url ?? '',
    auth_secret_name: partner?.auth_secret_name ?? '',
    contact_email: partner?.contact_email ?? '',
    id: partner?.id,
    // Ensure Select-bound fields are always strings, never null/undefined from DB
    org_type: partner?.org_type ?? 'foundation',
    auth_type: partner?.auth_type ?? 'none',
    status: partner?.status ?? 'inactive',
  });
  const [errors, setErrors] = useState({});

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.name || !formData.name.trim()) {
      newErrors.name = 'Partner name is required.';
    }
    if (formData.contact_email && !isValidEmail(formData.contact_email)) {
      newErrors.contact_email = 'Please enter a valid email address.';
    }
    if (formData.api_base_url) {
      try {
        const parsed = new URL(formData.api_base_url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          newErrors.api_base_url = 'Please enter a valid http(s) URL.';
        }
      } catch (_) {
        newErrors.api_base_url = 'Please enter a valid URL.';
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    // Ensure the partner ID is included when saving.
    onSave({ ...formData, name: formData.name.trim(), id: partner?.id });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Partner Name</Label>
        <Input id="name" value={formData.name ?? ''} onChange={(e) => handleChange('name', e.target.value)} />
        {errors.name && <p className="text-sm text-red-500">{errors.name}</p>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="org_type">Organization Type</Label>
          <Select value={formData.org_type} onValueChange={(v) => handleChange('org_type', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="university">University</SelectItem>
              <SelectItem value="utility">Utility</SelectItem>
              <SelectItem value="foundation">Foundation</SelectItem>
              <SelectItem value="municipality">Municipality</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <Select value={formData.status} onValueChange={(v) => handleChange('status', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="throttled">Throttled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="api_base_url">API Base URL</Label>
        <Input id="api_base_url" value={formData.api_base_url ?? ''} onChange={(e) => handleChange('api_base_url', e.target.value)} placeholder="https://api.partner.com" />
        {errors.api_base_url && <p className="text-sm text-red-500">{errors.api_base_url}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="contact_email">Contact Email</Label>
        <Input id="contact_email" type="email" value={formData.contact_email ?? ''} onChange={(e) => handleChange('contact_email', e.target.value)} placeholder="contact@partner.com" />
        {errors.contact_email && <p className="text-sm text-red-500">{errors.contact_email}</p>}
      </div>
      <div className="grid grid-cols-2 gap-4">
         <div className="space-y-2">
          <Label htmlFor="auth_type">Auth Type</Label>
          <Select value={formData.auth_type} onValueChange={(v) => handleChange('auth_type', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="api_key">API Key</SelectItem>
              <SelectItem value="oauth2">OAuth2</SelectItem>
              <SelectItem value="signed_url">Signed URL</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="auth_secret_name">Auth Secret Name</Label>
          <Input id="auth_secret_name" value={formData.auth_secret_name ?? ''} onChange={(e) => handleChange('auth_secret_name', e.target.value)} placeholder="PARTNER_API_KEY" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSubmit}>Save Partner</Button>
      </DialogFooter>
    </div>
  );
};

const AIAddPartnerDialog = ({ open, onOpenChange, onFound }) => {
    const [partnerName, setPartnerName] = useState('');
    const { toast } = useToast();

    const aiAssistMutation = useMutation({
        mutationFn: (name) => client.integrations.Core.InvokeLLM({
            prompt: `You are a research assistant. Find information about the organization named '${name}'. Return its official website URL, a general public-facing contact email, and classify its organization type from this list: university, utility, foundation, municipality, other.`,
            add_context_from_internet: true,
            response_json_schema: {
                type: "object",
                properties: {
                    org_type: { "type": "string", "enum": ["university", "utility", "foundation", "municipality", "other"] },
                    api_base_url: { "type": "string", "description": "The main official website URL." },
                    contact_email: { "type": "string", "description": "A general contact email, like contact@ or info@." }
                }
            }
        }),
        onSuccess: (data) => {
            const newPartnerData = {
                name: partnerName,
                org_type: data.org_type || 'other',
                api_base_url: normalizeUrl(data.api_base_url),
                contact_email: isValidEmail(data.contact_email) ? data.contact_email : '',
                auth_type: 'none',
                status: 'inactive',
            };
            onFound(newPartnerData);
            onOpenChange(false); // Close dialog on success
            setPartnerName(''); // Clear input
        },
        onError: (error) => {
            toast({
                variant: "destructive",
                title: "AI Assistant Failed",
                description: `Could not find information. Please add manually. Error: ${error.message}`,
            });
        }
    });

    // Reset local state when the dialog visibility changes (in sync with UI).
    useEffect(() => {
        if (!open) {
            setPartnerName('');
        }
    }, [open]);

    const handleFind = () => {
        if (!partnerName) return;
        aiAssistMutation.mutate(partnerName);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2"><Sparkles className="w-5 h-5 text-purple-500" /> Add Partner with AI</DialogTitle>
                    <DialogDescription>Enter the name of the organization, and the AI will try to find its details.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <Label htmlFor="ai-partner-name">Partner Name</Label>
                        <Input
                            id="ai-partner-name"
                            value={partnerName}
                            onChange={(e) => setPartnerName(e.target.value)}
                            placeholder="e.g., Ford Foundation"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && partnerName && !aiAssistMutation.isPending) {
                                  handleFind();
                                }
                            }}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleFind} disabled={aiAssistMutation.isPending || !partnerName}>
                        {aiAssistMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Find & Pre-fill Form
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

// AISuggestionsDialog component has been removed and its logic integrated into SourceRegistry

const HealthStatusBadge = ({ status }) => {
  const styles = {
    active: 'bg-emerald-100 text-emerald-800',
    inactive: 'bg-slate-100 text-slate-800',
    throttled: 'bg-amber-100 text-amber-800',
    error: 'bg-red-100 text-red-800',
  };
  return <span className={`px-2 py-1 text-xs font-medium rounded-full ${styles[status] || styles.inactive}`}>{status}</span>;
};

const CrawlStatusIcon = ({ status }) => {
  switch (status) {
    case 'completed':
    case 'success':
      return <CheckCircle className="w-5 h-5 text-emerald-500" />;
    case 'failed':
    case 'error':
      return <XCircle className="w-5 h-5 text-red-500" />;
    case 'running':
      return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
    case 'pending':
    case 'queued':
      return <Clock className="w-5 h-5 text-amber-500" />;
    default:
      return <HelpCircle className="w-5 h-5 text-slate-400" />;
  }
};

export default function SourceRegistry() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isAIAddOpen, setIsAIAddOpen] = useState(false);
  // Renamed from isSuggestionsOpen and added aiSuggestions state
  const [aiSuggestionsModalOpen, setAiSuggestionsModalOpen] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState([]);
  const [selectedPartner, setSelectedPartner] = useState(null);

  const { data: partners = [], isLoading: isLoadingPartners } = useQuery({
    queryKey: ['partnerSources'],
    queryFn: () => client.entities.PartnerSource.list(),
  });
  
  const { data: crawlLogs = [], isLoading: isLoadingLogs } = useQuery({
    queryKey: ['crawlLogs'],
    queryFn: () => client.entities.CrawlLog.list('-created_date', 50),
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const mutation = useMutation({
    mutationFn: (partnerData) => {
      const { id, ...data } = partnerData;
      const isUpdate = !!id;
      const promise = id ? client.entities.PartnerSource.update(id, data) : client.entities.PartnerSource.create(data);
      return Promise.resolve(promise).then((result) => ({ result, isUpdate }));
    },
    onSuccess: ({ isUpdate }) => {
      queryClient.invalidateQueries({ queryKey: ['partnerSources'] });
      setIsFormOpen(false);
      setSelectedPartner(null);
      toast({
        title: "Partner saved successfully",
        description: isUpdate ? "Partner updated." : "New partner added.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to save partner",
        description: error.message || "An unexpected error occurred.",
      });
    }
  });

  const deletePartnerMutation = useMutation({
    mutationFn: (id) => client.entities.PartnerSource.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partnerSources'] });
      toast({
        title: "Partner deleted",
        description: "Partner source has been removed.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to delete partner",
        description: error.message || "An unexpected error occurred.",
      });
    }
  });

  const runFeedMutation = useMutation({
    mutationFn: (partnerId) => client.functions.invoke('runPartnerFeed', { partner_id: partnerId }),
    onSuccess: (data, partnerId) => {
        const partner = partners.find(p => p.id === partnerId);
        toast({
            title: `Feed Run Initiated for ${partner?.name || 'Partner'}`,
            description: `Check activity log for status.`,
        });
        queryClient.invalidateQueries({ queryKey: ['crawlLogs'] });
    },
    onError: (error, partnerId) => {
        const partner = partners.find(p => p.id === partnerId);
        toast({
            variant: "destructive",
            title: `Feed Run Failed for ${partner?.name || 'Partner'}`,
            description: error.message,
        });
    }
  });
  
  // Moved and adapted AISuggestionsDialog's mutation
  const aiGetSuggestionsMutation = useMutation({
    mutationFn: () => {
        const existingPartnerDetails = partners.map(p => `Name: ${p.name}, Type: ${p.org_type}, Status: ${p.status}`).join('; ');
        return client.integrations.Core.InvokeLLM({
            prompt: `Based on this list of existing funding sources: [${existingPartnerDetails}]. Suggest 5 new, similar organizations (foundations, corporate CSR programs, government bodies) that could also be good funding sources. For each suggestion, provide its official website URL, a general public-facing contact email, and classify its organization type from this list: university, utility, foundation, municipality, other. Do not include any from the existing list.`,
            add_context_from_internet: true,
            response_json_schema: {
                type: "object",
                properties: {
                    suggestions: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: { "type": "string" },
                                reason: { "type": "string", "description": "A brief reason why it's a good suggestion." },
                                org_type: { "type": "string", "enum": ["university", "utility", "foundation", "municipality", "other"], "description": "Type of organization." },
                                api_base_url: { "type": "string", "description": "The main official website URL, if available." },
                                contact_email: { "type": "string", "description": "A general contact email, like contact@ or info@, if available." }
                            },
                            required: ["name", "reason", "org_type"] // org_type is required, URL/email optional
                        }
                    }
                }
            }
        });
    },
    onSuccess: (data) => {
        const existingNames = new Set(partners.map(p => normalizeName(p.name)));
        const seen = new Set();
        const filtered = (data.suggestions || []).filter(s => {
            const key = normalizeName(s?.name);
            if (!key) return false;
            if (existingNames.has(key)) return false; // Filter out existing partners
            if (seen.has(key)) return false; // Dedupe within suggestions
            seen.add(key);
            return true;
        });
        setAiSuggestions(filtered);
    },
    onError: (error) => {
        toast({
            variant: "destructive",
            title: "AI Suggestions Failed",
            description: `Could not load suggestions. Error: ${error.message}`,
        });
        setAiSuggestions([]); // Clear suggestions on error
    }
  });

  const addMultipleSuggestionsMutation = useMutation({
    mutationFn: async (suggestions) => {
      const results = [];
      const existingNames = new Set(partners.map(p => normalizeName(p.name)));
      const processedNames = new Set();
      for (const suggestion of suggestions) {
        const key = normalizeName(suggestion.name);
        if (!key) {
          results.push({ success: false, name: suggestion.name, error: 'Invalid name' });
          continue;
        }
        if (existingNames.has(key) || processedNames.has(key)) {
          results.push({ success: false, name: suggestion.name, error: 'Duplicate (already exists)' });
          continue;
        }
        processedNames.add(key);
        try {
          const newPartner = await client.entities.PartnerSource.create({
            name: suggestion.name,
            org_type: suggestion.org_type || 'other',
            api_base_url: normalizeUrl(suggestion.api_base_url),
            contact_email: isValidEmail(suggestion.contact_email) ? suggestion.contact_email : '',
            auth_type: 'none',
            auth_secret_name: '',
            status: 'inactive',
          });
          results.push({ success: true, source: newPartner });
        } catch (error) {
          results.push({ success: false, name: suggestion.name, error: error.message });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ['partnerSources'] });
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      if (successCount > 0) {
        toast({
          title: `Added ${successCount} Partner${successCount > 1 ? 's' : ''}`,
          description: failCount > 0 ? `${failCount} skipped or failed` : undefined,
        });
      }
      
      if (failCount > 0) {
        const failedNames = results.filter(r => !r.success).map(r => r.name).join(', ');
        toast({
          variant: "destructive",
          title: `Could not add ${failCount} Partner${failCount > 1 ? 's' : ''}`,
          description: failedNames,
        });
      }
      
      setSelectedSuggestions([]);
      setAiSuggestionsModalOpen(false);
    },
  });

  const aiGetSuggestionsMutate = aiGetSuggestionsMutation.mutate;
  const aiGetSuggestionsMutationReset = aiGetSuggestionsMutation.reset;

  useEffect(() => {
    if (aiSuggestionsModalOpen) {
      aiGetSuggestionsMutate();
    } else {
      aiGetSuggestionsMutationReset();
      setAiSuggestions([]);
      setSelectedSuggestions([]);
    }
  }, [aiSuggestionsModalOpen, aiGetSuggestionsMutate, aiGetSuggestionsMutationReset]);

  const handleSave = (data) => {
    mutation.mutate(data);
  };

  if (isLoadingPartners || isLoadingLogs) {
    return <div className="flex justify-center items-center h-screen"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  }
  
  const handleAIAddFound = (newPartnerData) => {
    setSelectedPartner(newPartnerData);
    setIsAIAddOpen(false); // Close AI add dialog
    setIsFormOpen(true); // Open main form with pre-filled data
  };
  
  // handleAddFromSuggestion is no longer used due to multi-select functionality

  const handleToggleSuggestion = (suggestion) => {
    setSelectedSuggestions(prev => {
      const isSelected = prev.find(s => s.name === suggestion.name);
      if (isSelected) {
        return prev.filter(s => s.name !== suggestion.name);
      } else {
        return [...prev, suggestion];
      }
    });
  };

  const handleAddSelectedSuggestions = () => {
    if (selectedSuggestions.length > 0) {
      addMultipleSuggestionsMutation.mutate(selectedSuggestions);
    }
  };

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Data Source Registry</h1>
            <p className="text-slate-600 mt-1">Manage partner feeds and monitor crawler health.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAiSuggestionsModalOpen(true)}>
                <Wand2 className="w-4 h-4 mr-2"/> Get Suggestions
            </Button>
            <Button variant="outline" onClick={() => setIsAIAddOpen(true)}>
                <Sparkles className="w-4 h-4 mr-2"/> Add with AI
            </Button>
            <Button onClick={() => { setSelectedPartner(null); setIsFormOpen(true); }}>
              <Plus className="w-4 h-4 mr-2"/> Add Manually
            </Button>
          </div>
        </div>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Partner Feeds</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Success</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partners.map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{p.org_type}</TableCell>
                    <TableCell><HealthStatusBadge status={p.status} /></TableCell>
                    <TableCell>{p.last_success_at ? safeDistanceToNow(p.last_success_at, 'Unknown') : 'Never'}</TableCell>
                    <TableCell className="flex gap-1">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => runFeedMutation.mutate(p.id)} 
                        disabled={runFeedMutation.isPending && runFeedMutation.variables === p.id}
                      >
                         {runFeedMutation.isPending && runFeedMutation.variables === p.id ? <Loader2 className="w-4 h-4 animate-spin"/> : <Play className="w-4 h-4"/>}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setSelectedPartner(p); setIsFormOpen(true); }}><Edit className="w-4 h-4"/></Button>
                      <Button variant="ghost" size="sm" onClick={() => deletePartnerMutation.mutate(p.id)}><Trash2 className="w-4 h-4 text-red-500"/></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity /> System Activity Log</CardTitle>
            <CardDescription>Recent activity from background jobs and data crawlers.</CardDescription>
          </CardHeader>
          <CardContent>
             <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source / Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Records Found</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {crawlLogs.map(log => (
                  <TableRow key={log.id}>
                    <TableCell className="font-medium">{log.source}</TableCell>
                    <TableCell>
                      <CrawlStatusIcon status={log.status} />
                    </TableCell>
                    <TableCell>{log.records_found ?? log.recordsFound ?? 0}</TableCell>
                    <TableCell>{safeDistanceToNow(log.created_date, 'Unknown')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {isFormOpen && (
          <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{selectedPartner?.id ? 'Edit' : 'Add'} Partner Source</DialogTitle>
              </DialogHeader>
              <PartnerForm partner={selectedPartner} onSave={handleSave} onCancel={() => setIsFormOpen(false)} />
            </DialogContent>
          </Dialog>
        )}

        <AIAddPartnerDialog
            open={isAIAddOpen}
            onOpenChange={setIsAIAddOpen}
            onFound={handleAIAddFound}
        />
        
        {/* AI Suggestions Dialog - MODIFIED (Inline implementation) */}
        <Dialog open={aiSuggestionsModalOpen} onOpenChange={setAiSuggestionsModalOpen}>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Wand2 className="w-5 h-5 text-blue-500" />
                        AI Partner Suggestions
                    </DialogTitle>
                    <DialogDescription>
                        Select one or more potential funding sources to add to your registry.
                    </DialogDescription>
                </DialogHeader>
                
                <div className="py-4">
                    {aiGetSuggestionsMutation.isPending && (
                        <div className="flex items-center justify-center h-40">
                            <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
                        </div>
                    )}
                    {aiGetSuggestionsMutation.isSuccess && aiSuggestions.length > 0 && (
                        <ul className="space-y-3">
                            {aiSuggestions.map((suggestion, index) => {
                                const isSelected = selectedSuggestions.find(s => s.name === suggestion.name);
                                
                                return (
                                    <li
                                        key={index}
                                        className={`border rounded-lg p-4 transition-all cursor-pointer ${
                                            isSelected 
                                                ? 'border-blue-500 bg-blue-50' 
                                                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                        }`}
                                        onClick={() => handleToggleSuggestion(suggestion)}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className="flex items-center pt-1">
                                                <input
                                                    type="checkbox"
                                                    checked={!!isSelected}
                                                    onChange={() => handleToggleSuggestion(suggestion)}
                                                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                                                    onClick={(e) => e.stopPropagation()}
                                                />
                                            </div>
                                            <div className="flex-1">
                                                <div className="font-semibold text-slate-900">{suggestion.name}</div>
                                                <p className="text-sm text-slate-600 mt-1">{suggestion.reason || ''}</p> 
                                                {normalizeUrl(suggestion.api_base_url) && (
                                                    <a
                                                        href={normalizeUrl(suggestion.api_base_url)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-xs text-blue-600 hover:underline mt-2 inline-flex items-center gap-1"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <ExternalLink className="w-3 h-3" />
                                                        {normalizeUrl(suggestion.api_base_url)}
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {aiGetSuggestionsMutation.isSuccess && aiSuggestions.length === 0 && (
                        <div className="text-center text-slate-500 py-10">
                            <p className="font-semibold">No new suggestions found.</p>
                            <p className="text-sm">The AI couldn't find any new partners based on your current list.</p>
                        </div>
                    )}
                    {aiGetSuggestionsMutation.isError && (
                        <div className="text-center text-red-500 py-10">
                            <p className="font-semibold">Could not load suggestions.</p>
                            <p className="text-sm">{aiGetSuggestionsMutation.error?.message}</p>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between mt-6 pt-4 border-t">
                    <div className="text-sm text-slate-600">
                        {selectedSuggestions.length > 0 && (
                            <span className="font-medium text-slate-900">
                                {selectedSuggestions.length} selected
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button 
                            variant="outline" 
                            onClick={() => {
                                setAiSuggestionsModalOpen(false);
                                setSelectedSuggestions([]);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleAddSelectedSuggestions}
                            disabled={selectedSuggestions.length === 0 || addMultipleSuggestionsMutation.isPending}
                        >
                            {addMultipleSuggestionsMutation.isPending ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding...</>
                            ) : (
                                <>Add {selectedSuggestions.length > 0 ? `${selectedSuggestions.length} ` : ''}Partner{selectedSuggestions.length !== 1 ? 's' : ''}</>
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
