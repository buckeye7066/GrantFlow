import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Mail, Send, Loader2, MessageCircle, AlertCircle, Lightbulb, Settings } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';

export default function AdminMessages() {
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [response, setResponse] = useState('');
  const queryClient = useQueryClient();

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const isAdmin = user?.email === 'buckeye7066@gmail.com';

  // Fetch all messages (admin only) and sort newest-first client-side
  const { data: allMessagesRaw = [], isLoading } = useQuery({
    queryKey: ['allMessages', isAdmin],
    queryFn: async () => (await base44.entities.Message.list()) || [],
    enabled: !!isAdmin,
  });

  const allMessages = useMemo(() => {
    return [...allMessagesRaw].sort((a, b) => {
      const da = new Date(a?.created_at ?? a?.created_date ?? 0).getTime();
      const db = new Date(b?.created_at ?? b?.created_date ?? 0).getTime();
      return db - da; // newest first
    });
  }, [allMessagesRaw]);

  const markReadMutation = useMutation({
    mutationFn: async (messageId) => {
      return await base44.entities.Message.update(messageId, { status: 'read' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allMessages', isAdmin] });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ messageId, responseText }) => {
      return await base44.entities.Message.update(messageId, {
        admin_response: responseText,
        status: 'replied',
        response_date: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allMessages', isAdmin] });
      setResponse('');
      setSelectedMessage(null);
      sonnerToast.success('Response sent successfully');
    },
  });

  const handleSelectMessage = (message) => {
    setSelectedMessage(message);
    const status = message?.status || 'unread';
    if (status === 'unread') {
      markReadMutation.mutate(message.id);
    }
  };

  const handleSendResponse = () => {
    if (!response.trim()) {
      sonnerToast.error('Please enter a response');
      return;
    }
    if (!selectedMessage?.id) {
      sonnerToast.error('No message selected');
      return;
    }
    replyMutation.mutate({
      messageId: selectedMessage.id,
      responseText: response,
    });
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <Card>
          <CardContent className="p-12 text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <p className="text-slate-600">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 p-6 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const safeMessages = Array.isArray(allMessages) ? allMessages : [];
  const unreadMessages = safeMessages.filter((m) => !m.status || m.status === 'unread');
  const readMessages = safeMessages.filter((m) => m.status === 'read');
  const repliedMessages = safeMessages.filter((m) => m.status === 'replied');

  const getTypeIcon = (type) => {
    switch (type) {
      case 'app_issue':
        return <AlertCircle className="w-4 h-4" />;
      case 'feature_request':
        return <Lightbulb className="w-4 h-4" />;
      case 'support':
        return <Settings className="w-4 h-4" />;
      default:
        return <MessageCircle className="w-4 h-4" />;
    }
  };

  const formatType = (type) => (type ? type.replace(/_/g, ' ') : 'general');

  const renderMessageCard = (message) => {
    const created = message?.created_at ?? message?.created_date;
    const dt = created ? new Date(created) : null;
    const dateStr = dt && !isNaN(dt.getTime()) ? dt.toLocaleDateString() : '';
    const timeStr = dt && !isNaN(dt.getTime()) ? dt.toLocaleTimeString() : '';
    return (
      <div
        key={message.id}
        onClick={() => handleSelectMessage(message)}
        className={`p-4 border rounded-lg cursor-pointer transition-all ${
          selectedMessage?.id === message.id ? 'bg-blue-50 border-blue-300 shadow-md' : 'bg-white hover:bg-slate-50 hover:shadow'
        }`}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              {getTypeIcon(message?.message_type)}
              <h3 className="font-semibold text-slate-900">{message?.subject || '(no subject)'}</h3>
            </div>
            <p className="text-sm text-slate-600">From: {message?.from_user_name || '(unknown user)'}</p>
            <p className="text-xs text-slate-500">{message?.from_user_email || ''}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge variant={message?.message_type === 'app_issue' ? 'destructive' : 'secondary'}>
              {formatType(message?.message_type)}
            </Badge>
            {message?.ai_generated && <Badge variant="outline" className="text-xs">AI</Badge>}
          </div>
        </div>
        <p className="text-sm text-slate-600 line-clamp-2">{message?.message || ''}</p>
        <p className="text-xs text-slate-500 mt-2">
          {dateStr}
          {timeStr ? ` at ${timeStr}` : ''}
        </p>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Mail className="w-8 h-8 text-blue-600" />
            Admin Messages
          </h1>
          <p className="text-slate-600 mt-1">Messages from GrantFlow users • {unreadMessages.length} unread</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          <div>
            <Tabs defaultValue="unread" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="unread">Unread ({unreadMessages.length})</TabsTrigger>
                <TabsTrigger value="read">Read ({readMessages.length})</TabsTrigger>
                <TabsTrigger value="replied">Replied ({repliedMessages.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="unread" className="space-y-3 mt-4">
                {unreadMessages.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <Mail className="w-12 h-12 text-slate-300 mx-auto mb-2" />
                      <p className="text-slate-500">No unread messages</p>
                    </CardContent>
                  </Card>
                ) : (
                  unreadMessages.map(renderMessageCard)
                )}
              </TabsContent>

              <TabsContent value="read" className="space-y-3 mt-4">
                {readMessages.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <p className="text-slate-500">No read messages</p>
                    </CardContent>
                  </Card>
                ) : (
                  readMessages.map(renderMessageCard)
                )}
              </TabsContent>

              <TabsContent value="replied" className="space-y-3 mt-4">
                {repliedMessages.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <p className="text-slate-500">No replied messages</p>
                    </CardContent>
                  </Card>
                ) : (
                  repliedMessages.map(renderMessageCard)
                )}
              </TabsContent>
            </Tabs>
          </div>

          <div>
            {selectedMessage ? (
              <Card className="sticky top-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {getTypeIcon(selectedMessage?.message_type)}
                    {selectedMessage?.subject || '(no subject)'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="p-4 bg-slate-50 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold">From: {selectedMessage?.from_user_name || '(unknown user)'}</p>
                      <Badge>{formatType(selectedMessage?.message_type)}</Badge>
                    </div>
                    <p className="text-xs text-slate-500 mb-3">{selectedMessage?.from_user_email || ''}</p>
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{selectedMessage?.message || ''}</p>
                    <p className="text-xs text-slate-500 mt-3">
                      Sent:{' '}
                      {(() => {
                        const created = selectedMessage?.created_at ?? selectedMessage?.created_date;
                        const dt = created ? new Date(created) : null;
                        return dt && !isNaN(dt.getTime()) ? dt.toLocaleString() : '';
                      })()}
                    </p>
                  </div>

                  {selectedMessage?.admin_response ? (
                    <div className="p-4 bg-blue-50 border-l-4 border-blue-600 rounded">
                      <p className="text-sm font-semibold text-blue-900 mb-2">Your Response:</p>
                      <p className="text-sm text-slate-700 whitespace-pre-wrap">
                        {selectedMessage?.admin_response || ''}
                      </p>
                      {selectedMessage?.response_date && (
                        <p className="text-xs text-slate-500 mt-2">
                          Sent:{' '}
                          {(() => {
                            const dt = new Date(selectedMessage.response_date);
                            return !isNaN(dt.getTime()) ? dt.toLocaleString() : '';
                          })()}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <label className="text-sm font-medium block">Your Response</label>
                      <Textarea
                        value={response}
                        onChange={(e) => setResponse(e.target.value)}
                        placeholder="Type your response as Dr. John White..."
                        rows={6}
                      />
                      <Button onClick={handleSendResponse} disabled={replyMutation.isPending} className="w-full">
                        {replyMutation.isPending ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Send className="w-4 h-4 mr-2" />
                            Send Response to {selectedMessage?.from_user_name || 'user'}
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-12 text-center">
                  <MessageCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-500">Select a message to view and respond</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}