import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Mail, Sparkles, Send, Loader2, MessageCircle, CheckCircle2, Palette, X } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';

const DEFAULT_THEME = {
  bgColor: '#f8fafc',
  cardBg: '#ffffff',
  primaryColor: '#2563eb',
  textColor: '#0f172a',
  fontFamily: 'system-ui',
};

const FONT_OPTIONS = [
  { value: 'system-ui', label: 'System Default' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: '"Times New Roman", serif', label: 'Times New Roman' },
  { value: '"Courier New", monospace', label: 'Courier New' },
  { value: '"Comic Sans MS", cursive', label: 'Comic Sans' },
];

export default function SendMessage() {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('general');
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [theme, setTheme] = useState(DEFAULT_THEME);

  const queryClient = useQueryClient();

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  useEffect(() => {
    const saved = localStorage.getItem('messagePageTheme');
    if (saved) {
      try {
        setTheme(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load theme', e);
      }
    }
  }, []);

  const saveTheme = (newTheme) => {
    setTheme(newTheme);
    localStorage.setItem('messagePageTheme', JSON.stringify(newTheme));
    sonnerToast.success('Theme saved');
  };

  const resetTheme = () => {
    setTheme(DEFAULT_THEME);
    localStorage.removeItem('messagePageTheme');
    sonnerToast.success('Theme reset to default');
  };

  const { data: myMessagesRaw = [], isLoading: isLoadingMessages } = useQuery({
    queryKey: ['myMessages', user?.email],
    queryFn: () =>
      base44.entities.Message.filter({ from_user_email: user?.email }),
    enabled: !!user?.email,
  });

  // Client-side sort: newest first
  const myMessages = useMemo(() => {
    return [...myMessagesRaw].sort((a, b) => {
      const da = new Date(a?.created_at ?? a?.created_date ?? 0).getTime();
      const db = new Date(b?.created_at ?? b?.created_date ?? 0).getTime();
      return db - da;
    });
  }, [myMessagesRaw]);

  const sendMutation = useMutation({
    mutationFn: async (data) => {
      const newMessage = await base44.entities.Message.create(data);

      // Send email notification to admin (non-blocking)
      try {
        const response = await base44.functions.invoke('notifyAdminNewMessage', {
          messageId: newMessage.id,
        });
        if (response?.data?.success === false) {
          console.warn('notifyAdminNewMessage returned failure:', response?.data?.error);
        }
      } catch (error) {
        console.error('Failed to send notification:', error?.message || error);
      }

      return newMessage;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myMessages', user?.email] });
      setShowSuccess(true);
      setSubject('');
      setMessage('');
      setMessageType('general');
      sonnerToast.success('Message sent to Dr. John White');
      setTimeout(() => setShowSuccess(false), 5000);
    },
    onError: () => {
      sonnerToast.error('Failed to send message');
    },
  });

  const handleAIGenerate = async () => {
    if (!subject) {
      sonnerToast.error('Please enter a subject first');
      return;
    }

    setIsGenerating(true);
    try {
      const response = await base44.integrations?.Core?.InvokeLLM?.({
        prompt: `You are helping a user report an app issue to Dr. John White, the developer of GrantFlow.

Subject: ${subject}

Write a clear, professional message describing the issue. Include:
1. What they were trying to do
2. What went wrong
3. Any error messages or unexpected behavior
4. Request for help

Keep it concise and professional. Write in first person from the user's perspective.`,
        response_json_schema: null,
      });

      const aiText =
        response?.output ?? response?.text ?? (typeof response === 'string' ? response : '');
      if (aiText) {
        setMessage(aiText);
        sonnerToast.success('AI generated message - feel free to edit it');
      } else {
        sonnerToast.error('AI did not return any text');
      }
    } catch (error) {
      sonnerToast.error('Failed to generate message');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!user?.email) {
      sonnerToast.error('User not authenticated yet. Please wait a moment.');
      return;
    }
    sendMutation.mutate({
      from_user_email: user.email,
      from_user_name: user.full_name || user.email,
      subject,
      message,
      message_type: messageType,
      ai_generated: messageType === 'app_issue',
    });
  };

  const safeTheme = theme || DEFAULT_THEME;

  return (
    <div
      className="min-h-screen p-6 transition-colors duration-300"
      style={{
        backgroundColor: safeTheme.bgColor,
        color: safeTheme.textColor,
        fontFamily: safeTheme.fontFamily,
      }}
    >
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1
              className="text-3xl font-bold flex items-center gap-2"
              style={{ color: safeTheme.textColor }}
            >
              <Mail className="w-8 h-8" style={{ color: safeTheme.primaryColor }} />
              Contact Dr. John White
            </h1>
            <p className="mt-1 opacity-70">Send a message to the app administrator</p>
          </div>
          <Button onClick={() => setShowCustomize(!showCustomize)} variant="outline" className="gap-2">
            <Palette className="w-4 h-4" />
            Customize
          </Button>
        </div>

        {showCustomize && (
          <Card style={{ backgroundColor: safeTheme.cardBg, color: safeTheme.textColor }}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle style={{ color: safeTheme.textColor }}>Customize Appearance</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setShowCustomize(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Background Color</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={safeTheme.bgColor}
                      onChange={(e) => saveTheme({ ...safeTheme, bgColor: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                    />
                    <Input
                      value={safeTheme.bgColor}
                      onChange={(e) => saveTheme({ ...safeTheme, bgColor: e.target.value })}
                      placeholder="#f8fafc"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Card Background</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={safeTheme.cardBg}
                      onChange={(e) => saveTheme({ ...safeTheme, cardBg: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                    />
                    <Input
                      value={safeTheme.cardBg}
                      onChange={(e) => saveTheme({ ...safeTheme, cardBg: e.target.value })}
                      placeholder="#ffffff"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Primary Color</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={safeTheme.primaryColor}
                      onChange={(e) => saveTheme({ ...safeTheme, primaryColor: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                    />
                    <Input
                      value={safeTheme.primaryColor}
                      onChange={(e) => saveTheme({ ...safeTheme, primaryColor: e.target.value })}
                      placeholder="#2563eb"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Text Color</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={safeTheme.textColor}
                      onChange={(e) => saveTheme({ ...safeTheme, textColor: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                    />
                    <Input
                      value={safeTheme.textColor}
                      onChange={(e) => saveTheme({ ...safeTheme, textColor: e.target.value })}
                      placeholder="#0f172a"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Font Family</label>
                <Select
                  value={safeTheme.fontFamily}
                  onValueChange={(value) => saveTheme({ ...safeTheme, fontFamily: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FONT_OPTIONS.map((font) => (
                      <SelectItem key={font.value} value={font.value}>
                        <span style={{ fontFamily: font.value }}>{font.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button onClick={resetTheme} variant="outline" className="w-full">
                Reset to Default
              </Button>
            </CardContent>
          </Card>
        )}

        {showSuccess && (
          <Alert
            className="border-2"
            style={{ backgroundColor: `${safeTheme.primaryColor}20`, borderColor: safeTheme.primaryColor }}
          >
            <CheckCircle2 className="w-4 h-4" style={{ color: safeTheme.primaryColor }} />
            <AlertDescription style={{ color: safeTheme.textColor }}>
              Your message has been sent successfully! Dr. John White will respond soon.
            </AlertDescription>
          </Alert>
        )}

        <Card style={{ backgroundColor: safeTheme.cardBg, color: safeTheme.textColor }}>
          <CardHeader>
            <CardTitle style={{ color: safeTheme.textColor }}>New Message</CardTitle>
            <CardDescription style={{ color: safeTheme.textColor, opacity: 0.7 }}>
              Dr. John White deeply values your feedback and questions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Message Type</label>
                <Select value={messageType} onValueChange={setMessageType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">General Inquiry</SelectItem>
                    <SelectItem value="app_issue">App Issue / Bug Report</SelectItem>
                    <SelectItem value="feature_request">Feature Request</SelectItem>
                    <SelectItem value="support">Support Request</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Subject *</label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="What's this about?"
                  required
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">Message *</label>
                  {messageType === 'app_issue' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAIGenerate}
                      disabled={isGenerating || !subject}
                      className="gap-2"
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4" />
                          AI Write Issue Report
                        </>
                      )}
                    </Button>
                  )}
                </div>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type your message here..."
                  rows={8}
                  required
                />
              </div>

              <Button
                type="submit"
                disabled={sendMutation.isPending}
                className="w-full"
                style={{ backgroundColor: safeTheme.primaryColor, color: '#ffffff' }}
              >
                {sendMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Send Message
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {Array.isArray(myMessages) && myMessages.length > 0 && (
          <Card style={{ backgroundColor: safeTheme.cardBg, color: safeTheme.textColor }}>
            <CardHeader>
              <CardTitle style={{ color: safeTheme.textColor }}>Your Previous Messages</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {myMessages.map((msg) => {
                const created = msg?.created_at ?? msg?.created_date;
                const createdDt = created ? new Date(created) : null;
                const createdStr = createdDt && !isNaN(createdDt.getTime()) ? createdDt.toLocaleDateString() : '';
                return (
                  <div
                    key={msg.id}
                    className="p-4 border rounded-lg transition-colors"
                    style={{ backgroundColor: safeTheme.cardBg, borderColor: `${safeTheme.textColor}20` }}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <MessageCircle className="w-4 h-4" style={{ color: safeTheme.primaryColor }} />
                          <h3 className="font-semibold" style={{ color: safeTheme.textColor }}>
                            {msg.subject}
                          </h3>
                        </div>
                        <p className="text-xs mt-1" style={{ color: safeTheme.textColor, opacity: 0.6 }}>
                          {createdStr}
                        </p>
                      </div>
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          msg.status === 'replied'
                            ? 'bg-green-100 text-green-800'
                            : msg.status === 'read'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-slate-100 text-slate-800'
                        }`}
                      >
                        {msg.status}
                      </span>
                    </div>
                    <p className="text-sm mb-2" style={{ color: safeTheme.textColor, opacity: 0.8 }}>
                      {msg.message}
                    </p>
                    {msg.admin_response && (
                      <div
                        className="mt-3 p-3 rounded"
                        style={{
                          backgroundColor: `${safeTheme.primaryColor}10`,
                          borderLeft: `4px solid ${safeTheme.primaryColor}`,
                        }}
                      >
                        <p className="text-xs font-semibold mb-1" style={{ color: safeTheme.primaryColor }}>
                          Response from Dr. John White:
                        </p>
                        <p className="text-sm" style={{ color: safeTheme.textColor }}>{msg.admin_response}</p>
                        {msg.response_date && (
                          <p className="text-xs mt-1" style={{ color: safeTheme.textColor, opacity: 0.6 }}>
                            {new Date(msg.response_date).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}