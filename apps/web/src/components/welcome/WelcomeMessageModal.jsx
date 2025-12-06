import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Heart, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

export default function WelcomeMessageModal({ message, onDismiss, isOpen }) {
  if (!message) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <span>{message.subject || 'Welcome to GrantFlow'}</span>
          </DialogTitle>
        </DialogHeader>
        
        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="prose prose-slate prose-sm max-w-none">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-4 text-slate-700 leading-relaxed">{children}</p>,
                h1: ({ children }) => <h1 className="text-xl font-bold text-slate-900 mb-4">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-semibold text-slate-800 mt-6 mb-3">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold text-slate-800 mt-4 mb-2">{children}</h3>,
                strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-4 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-4 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="text-slate-700">{children}</li>,
              }}
            >
              {message.body}
            </ReactMarkdown>
          </div>
        </ScrollArea>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button onClick={onDismiss} className="bg-blue-600 hover:bg-blue-700">
            <Heart className="w-4 h-4 mr-2" />
            Thank You, Let's Begin
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}