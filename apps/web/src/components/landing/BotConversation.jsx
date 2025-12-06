import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bot, Sparkles, Users, Zap, Target, Play, Pause } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const CONVERSATIONS = [
  {
    name: 'Grant Discovery',
    icon: Sparkles,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    conversation: [
      { speaker: 'Anya', text: "Hey Yana! Let me show you how GrantFlow discovers funding opportunities. It's like having a research assistant working 24/7!" },
      { speaker: 'Yana', text: "That sounds amazing! How does the discovery process work?" },
      { speaker: 'Anya', text: "We use AI to scan thousands of funding sources - federal grants, foundations, state programs, even local opportunities. The system automatically matches them to your organization's profile." },
      { speaker: 'Yana', text: "So it's not just keyword searching?" },
      { speaker: 'Anya', text: "Exactly! It analyzes your mission, location, demographics, program focus, and more. Each opportunity gets a match score, so you see the best fits first!" },
      { speaker: 'Yana', text: "And I heard there's automated daily discovery?" },
      { speaker: 'Anya', text: "Yes! Set it up once, and every night at midnight, new matching grants are automatically added to your pipeline. You wake up to fresh opportunities!" }
    ]
  },
  {
    name: 'AI Writing Assistant',
    icon: Users,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    conversation: [
      { speaker: 'Yana', text: "Anya, writing grant proposals is so time-consuming. How does GrantFlow help with that?" },
      { speaker: 'Anya', text: "Our AI Writing Assistant is a game-changer! It auto-fills proposal sections using your organization's data - mission, programs, budget, everything." },
      { speaker: 'Yana', text: "Wait, it writes the proposal FOR you?" },
      { speaker: 'Anya', text: "It creates intelligent first drafts! Executive summaries, project goals, evaluation plans - all customized to each funder's requirements. You just review and refine." },
      { speaker: 'Yana', text: "What about NOFO documents? Those are always so long and complicated." },
      { speaker: 'Anya', text: "Upload any NOFO and our AI Parser extracts all the key details - deadlines, requirements, scoring criteria. It even creates a checklist so you don't miss anything!" },
      { speaker: 'Yana', text: "This could save dozens of hours per application!" }
    ]
  },
  {
    name: 'Pipeline Management',
    icon: Zap,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
    conversation: [
      { speaker: 'Anya', text: "Let's talk about managing your grant pipeline, Yana. It's where all your opportunities come to life!" },
      { speaker: 'Yana', text: "I've always struggled to keep track of where each grant is in the process." },
      { speaker: 'Anya', text: "GrantFlow uses a visual Kanban board - Discovered, Interested, Drafting, Application Prep, Revision, Submitted, Awarded. Drag and drop to move grants through stages!" },
      { speaker: 'Yana', text: "And I can see everything at once?" },
      { speaker: 'Anya', text: "Exactly! Color-coded by match score, deadline urgency, and status. Filter by organization, funder, amount - however you need to view your portfolio." },
      { speaker: 'Yana', text: "What about automation? I don't want to manually move things." },
      { speaker: 'Anya', text: "That's the beauty! Enable auto-advancement and grants automatically progress through stages. Runs AI analysis, fills proposal sections, creates checklists - all while you sleep!" }
    ]
  },
  {
    name: 'Compliance & Deadlines',
    icon: Target,
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-50',
    conversation: [
      { speaker: 'Yana', text: "Anya, what about after you WIN a grant? Compliance reporting is always a nightmare." },
      { speaker: 'Anya', text: "GrantFlow has you covered! When a grant is awarded, the system automatically creates compliance milestones - quarterly reports, financials, site visits, everything." },
      { speaker: 'Yana', text: "Automatically? How does it know what's required?" },
      { speaker: 'Anya', text: "AI analyzes the award terms and generates a full compliance schedule. Then it sends you smart deadline alerts - context-aware reminders at 30, 14, 7, 3, and 1 day before due dates." },
      { speaker: 'Yana', text: "The reminders are actually helpful, not just generic?" },
      { speaker: 'Anya', text: "Exactly! Each alert includes specific preparation tips for that milestone. Plus there's stewardship tracking - monitor spending, burn rate, and generate compliance reports with one click." },
      { speaker: 'Yana', text: "This would have saved me from missing that report deadline last month!" }
    ]
  },
  {
    name: 'Smart Features',
    icon: Sparkles,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    conversation: [
      { speaker: 'Anya', text: "Yana, let me tell you about some of the smart features that make GrantFlow special!" },
      { speaker: 'Yana', text: "I'm all ears! What makes it 'smart'?" },
      { speaker: 'Anya', text: "Profile Matcher learns from your organization's characteristics and automatically suggests the best-fit grants. Item Search finds funding for specific needs like equipment or scholarships." },
      { speaker: 'Yana', text: "Ooh, that's useful! What about tracking time spent on grants?" },
      { speaker: 'Anya', text: "Built-in time tracking! Both automated and manual. The system logs all AI work automatically and bills it transparently. You can also track your own time with idle detection." },
      { speaker: 'Yana', text: "And I heard something about data sources?" },
      { speaker: 'Anya', text: "Yes! You can add custom funding sources - foundations, local programs, partner organizations. The system crawls them for new opportunities and adds them to your pipeline automatically!" }
    ]
  },
  {
    name: 'Pricing Tiers',
    icon: Target,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    conversation: [
      { speaker: 'Yana', text: "This all sounds incredible, Anya! How much does GrantFlow cost?" },
      { speaker: 'Anya', text: "We have four tiers! Hope tier starts at pay-what-you-can for organizations facing hardship - 1 profile, 10 AI searches monthly." },
      { speaker: 'Yana', text: "That's really accessible! What about for growing organizations?" },
      { speaker: 'Anya', text: "Growth tier gives you 5 profiles, 100 searches, advanced AI, and automation. Perfect for nonprofits managing multiple programs or consultants with several clients." },
      { speaker: 'Yana', text: "And for larger organizations?" },
      { speaker: 'Anya', text: "Impact tier has unlimited everything - profiles, searches, full automation, compliance tracking, priority support. Then Impact Enterprise adds dedicated success managers, custom training, and API access!" },
      { speaker: 'Yana', text: "So there's a tier for every organization size and budget!" }
    ]
  }
];

export default function BotConversation() {
  const [activeConvo, setActiveConvo] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    if (!isPlaying) return;

    const timer = setTimeout(() => {
      const currentConversation = CONVERSATIONS[activeConvo].conversation;
      
      if (messageIndex < currentConversation.length - 1) {
        setMessageIndex(messageIndex + 1);
      } else {
        // Move to next conversation
        if (activeConvo < CONVERSATIONS.length - 1) {
          setActiveConvo(activeConvo + 1);
          setMessageIndex(0);
        } else {
          // Loop back to start
          setActiveConvo(0);
          setMessageIndex(0);
        }
      }
    }, 3500); // 3.5 seconds per message

    return () => clearTimeout(timer);
  }, [messageIndex, activeConvo, isPlaying]);

  const currentTopic = CONVERSATIONS[activeConvo];
  const currentConversation = currentTopic.conversation;
  const Icon = currentTopic.icon;

  return (
    <Card className="max-w-4xl mx-auto bg-white/90 backdrop-blur-sm border-2">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-2xl flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-600" />
            Meet Anya & Yana
          </CardTitle>
          <Button
            onClick={() => setIsPlaying(!isPlaying)}
            variant="outline"
            size="sm"
          >
            {isPlaying ? (
              <>
                <Pause className="w-4 h-4 mr-2" />
                Pause
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Play
              </>
            )}
          </Button>
        </div>
        <p className="text-slate-600 text-sm">
          Our AI assistants explain what each tier offers
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Topic Selector */}
        <div className="flex gap-2 flex-wrap">
          {CONVERSATIONS.map((topic, idx) => {
            const TopicIcon = topic.icon;
            return (
              <Badge
                key={topic.name}
                variant={activeConvo === idx ? 'default' : 'outline'}
                className={`cursor-pointer transition-all ${
                  activeConvo === idx ? topic.bgColor : ''
                }`}
                onClick={() => {
                  setActiveConvo(idx);
                  setMessageIndex(0);
                }}
              >
                <TopicIcon className={`w-3 h-3 mr-1 ${activeConvo === idx ? topic.color : ''}`} />
                {topic.name}
              </Badge>
            );
          })}
        </div>

        {/* Current Topic Header */}
        <div className={`p-4 rounded-lg ${currentTopic.bgColor}`}>
          <div className="flex items-center gap-3">
            <Icon className={`w-8 h-8 ${currentTopic.color}`} />
            <div>
              <h3 className={`text-xl font-bold ${currentTopic.color}`}>
                {currentTopic.name}
              </h3>
              <p className="text-sm text-slate-600">
                Conversation in progress...
              </p>
            </div>
          </div>
        </div>

        {/* Conversation Display */}
        <div className="space-y-4 min-h-[300px]">
          <AnimatePresence mode="popLayout">
            {currentConversation.slice(0, messageIndex + 1).map((message, idx) => (
              <motion.div
                key={`${activeConvo}-${idx}`}
                initial={{ opacity: 0, x: message.speaker === 'Anya' ? -20 : 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className={`flex ${message.speaker === 'Yana' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] p-4 rounded-2xl ${
                    message.speaker === 'Anya'
                      ? 'bg-blue-100 border-2 border-blue-200'
                      : 'bg-purple-100 border-2 border-purple-200'
                  }`}
                  >
                  <div className="flex items-center gap-2 mb-2">
                    <Bot
                      className={`w-4 h-4 ${
                        message.speaker === 'Anya' ? 'text-blue-600' : 'text-purple-600'
                      }`}
                    />
                    <span
                      className={`font-semibold text-sm ${
                        message.speaker === 'Anya' ? 'text-blue-900' : 'text-purple-900'
                      }`}
                    >
                      {message.speaker}
                    </span>
                  </div>
                  <p
                    className={`text-sm leading-relaxed ${
                      message.speaker === 'Anya' ? 'text-blue-900' : 'text-purple-900'
                    }`}
                  >
                    {message.text}
                  </p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Progress Indicator */}
        <div className="flex items-center justify-center gap-2">
          {currentConversation.map((_, idx) => (
            <div
              key={idx}
              className={`h-2 rounded-full transition-all ${
                idx === messageIndex
                  ? 'w-8 bg-blue-600'
                  : idx < messageIndex
                  ? 'w-2 bg-blue-400'
                  : 'w-2 bg-slate-300'
              }`}
            />
          ))}
        </div>

        <p className="text-center text-xs text-slate-500">
          {isPlaying ? 'Auto-playing through all features' : 'Paused - click Play to continue'}
        </p>
      </CardContent>
    </Card>
  );
}