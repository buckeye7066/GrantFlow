import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { v4 as uuid } from "uuid"
import { Loader2, Search, Send, Sparkles, Plus, Shield, Database, Activity, Code, Wrench, ChevronDown, ChevronRight, Compass, FolderOpen, Kanban, User, Monitor, Trash2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
import { toast } from "@/components/ui/use-toast"
import { useAuthStore } from "@/stores/authStore"
import { createLogger } from "@/utils/logger"
import {
  getAnyaSessions,
  createAnyaSession,
  deleteAnyaSession,
  getAnyaMessages,
  postAnyaMessage,
  listAnyaTools,
  invokeAnyaTool,
  getAnyaTasks,
  createAnyaTask,
  updateAnyaTask,
} from "@/lib/anyaClient"
import { useAnyaContext, serializeAnyaContext } from "@/contexts/AnyaContext"
import { createPageUrl } from "@/utils"
import { useFeatureFlags } from "@/lib/featureFlags"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"

const MessageBubble = React.memo(function MessageBubble({ message }) {
  const isAssistant = message.role === "assistant"
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm shadow-sm transition",
        isAssistant
          ? "border-blue-200 bg-blue-50/80 text-slate-800"
          : "border-slate-200 bg-white text-slate-700",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-slate-600 pb-1">
        <Badge variant={isAssistant ? "secondary" : "outline"} className="text-[11px] uppercase tracking-wide">
          {isAssistant ? "Anya" : "You"}
        </Badge>
        <span>
          {message.created_at
            ? formatDistanceToNow(new Date(message.created_at), { addSuffix: true })
            : "now"}
        </span>
      </div>
      <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
      {message.tool_name ? (
        <div className="mt-2 space-y-2 text-xs text-slate-600">
          <div>
            Tool: <span className="font-mono text-xs text-slate-700">{message.tool_name}</span>
          </div>
          {message.tool_payload ? (
            <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white/80 p-2 text-xs text-slate-800">
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(message.tool_payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

export default function AnyaChat({ profileId }) {
  const user = useAuthStore((state) => state.user)
  const isAdmin = Boolean(user?.is_admin)
  const effectiveProfileId = profileId ?? null
  const [isUnavailable, setIsUnavailable] = useState(false)
  const log = useMemo(() => createLogger("AnyaChat"), [])
  
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [tools, setTools] = useState([])
  const [isLoadingTools, setIsLoadingTools] = useState(false)
  const [isCodeSearchOpen, setIsCodeSearchOpen] = useState(false)
  const [codeSearchForm, setCodeSearchForm] = useState({ query: "", scope: "" })
  const [isInvokingTool, setIsInvokingTool] = useState(false)
  const [isFetchingInsights, setIsFetchingInsights] = useState(false)
  const [tasks, setTasks] = useState([])
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)
  const [isSavingTask, setIsSavingTask] = useState(false)
  const [taskForm, setTaskForm] = useState({ title: "", dueDate: "" })
  const [isTasksExpanded, setIsTasksExpanded] = useState(false)
  const [updatingTaskId, setUpdatingTaskId] = useState(null)
  const [isAdminToolsOpen, setIsAdminToolsOpen] = useState(false)
  const [adminToolForm, setAdminToolForm] = useState({})
  const [invokingAdminTool, setInvokingAdminTool] = useState(null)
  const isSendingRef = React.useRef(false)

  const hasMessages = messages.length > 0
  const hasTasks = tasks.length > 0
  const hasCodeSearchTool = useMemo(
    () => tools.some((tool) => tool.name === "code.search"),
    [tools],
  )
  const hasGrantTool = useMemo(
    () => tools.some((tool) => tool.name === "grants.summarizeMatches"),
    [tools],
  )
  const hasQuickActions = hasCodeSearchTool || hasGrantTool
  
  const adminTools = useMemo(() => {
    if (!isAdmin) return {}

    const adminToolsList = tools.filter((tool) => tool.requiresAdmin)
    const categorized = new Set()

    const grouped = {
      diagnostics: adminToolsList.filter((t) => {
        const match = t.name === "admin.diagnostics" || t.name.startsWith("admin.system.")
        if (match) categorized.add(t.name)
        return match
      }),
      health: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.health.")
        if (match) categorized.add(t.name)
        return match
      }),
      crawler: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.crawler.")
        if (match) categorized.add(t.name)
        return match
      }),
      autonomous: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.anya.") || t.name.startsWith("admin.items.")
        if (match) categorized.add(t.name)
        return match
      }),
      code: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.code.")
        if (match) categorized.add(t.name)
        return match
      }),
      functions: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.functions.")
        if (match) categorized.add(t.name)
        return match
      }),
      database: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.db.")
        if (match) categorized.add(t.name)
        return match
      }),
      brain: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.brain.")
        if (match) categorized.add(t.name)
        return match
      }),
      other: adminToolsList.filter((t) => !categorized.has(t.name)),
    }

    return grouped
  }, [tools, isAdmin])
  
  const hasAdminTools = useMemo(() => {
    return isAdmin && Object.values(adminTools).some((group) => group.length > 0)
  }, [isAdmin, adminTools])
  
  const sortedTasks = useMemo(() => {
    if (tasks.length === 0) return []
    const statusWeight = {
      open: 0,
      in_progress: 1,
      completed: 2,
      cancelled: 3,
    }
    return [...tasks].sort((a, b) => {
      const aWeight = statusWeight[a.status] ?? 99
      const bWeight = statusWeight[b.status] ?? 99
      if (aWeight !== bWeight) return aWeight - bWeight
      if (a.due_date && b.due_date) {
        if (a.due_date < b.due_date) return -1
        if (a.due_date > b.due_date) return 1
      } else if (a.due_date && !b.due_date) {
        return -1
      } else if (!a.due_date && b.due_date) {
        return 1
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    })
  }, [tasks])
  const openTaskCount = useMemo(
    () => tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled").length,
    [tasks],
  )

  const refreshMessages = useCallback(
    async (targetSessionId) => {
      const effectiveId = targetSessionId ?? sessionId
      if (!effectiveId) return
      try {
        const history = await getAnyaMessages(effectiveId)
        setMessages(Array.isArray(history) ? history : [])
      } catch (error) {
        console.error("[AnyaChat] refresh failed", error)
      }
    },
    [sessionId],
  )

  const refreshTasks = useCallback(
    async (targetSessionId, { withLoading = false } = {}) => {
      const effectiveId = targetSessionId ?? sessionId
      if (!effectiveId) return
      try {
        if (withLoading) setIsLoadingTasks(true)
        const sessionTasks = await getAnyaTasks(effectiveId)
        setTasks(Array.isArray(sessionTasks) ? sessionTasks : [])
      } catch (error) {
        console.error("[AnyaChat] refresh tasks failed", error)
      } finally {
        if (withLoading) setIsLoadingTasks(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    let isMounted = true
    async function bootstrap() {
      setIsLoading(true)
      try {
        const sessions = await getAnyaSessions()

        const findExisting = (targetProfileId) =>
          sessions?.find((session) => {
            if (targetProfileId) {
              return session.profile_id === targetProfileId
            }
            return !session.profile_id
          })

        let desiredProfileId = effectiveProfileId ?? null
        let activeSession = findExisting(desiredProfileId)

        if (!activeSession) {
          try {
            activeSession = await createAnyaSession({ profileId: desiredProfileId ?? undefined })
          } catch (error) {
            // Common in admin contexts where `activeProfileId` can be unset/stale.
            // If the backend says the profile doesn't exist, fall back to a general (profile-less) session.
            const status = error?.status ?? null
            const message = String(error?.message || '')
            const isProfileMissing = status === 404 || /profile not found/i.test(message)
            if (!isProfileMissing) throw error

            desiredProfileId = null
            activeSession = findExisting(null)
            if (!activeSession) {
              activeSession = await createAnyaSession({ profileId: undefined })
            }
          }
        }
        if (!isMounted) return
        setSessionId(activeSession?.id ?? null)
        if (activeSession?.id) {
          await refreshMessages(activeSession.id)
          await refreshTasks(activeSession.id, { withLoading: true })
        }
      } catch (error) {
        console.error("[AnyaChat] bootstrap failed", error)
        setIsUnavailable(true)
        toast({
          variant: "destructive",
          title: "Unable to reach Anya",
          description: error instanceof Error ? error.message : "Please try again shortly.",
        })
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    if (effectiveProfileId || isAdmin) {
      bootstrap()
    } else {
      // No profile bound â surface a synthetic guidance message so Anya
      // fulfils Goal 10 (profile improvement) and Goal 14 (strategist).
      setMessages([
        {
          id: 'no-profile-guidance',
          role: 'assistant',
          created_at: new Date().toISOString(),
          content:
            'Hi! To get personalised grant matches I need a profile. Head to My Profiles to create or select one, then come back here and I can analyse your matches, flag gaps, and suggest next steps.',
        },
      ])
    }

    return () => {
      isMounted = false
    }
  }, [effectiveProfileId, isAdmin, refreshMessages, refreshTasks])

  useEffect(() => {
    let isMounted = true
    async function loadTools() {
      setIsLoadingTools(true)
      try {
        const available = await listAnyaTools({ includeAdmin: isAdmin })
        if (isMounted) {
          setTools(Array.isArray(available) ? available : [])
        }
      } catch (error) {
        console.error("[AnyaChat] load tools failed", error)
        setIsUnavailable(true)
      } finally {
        if (isMounted) {
          setIsLoadingTools(false)
        }
      }
    }
    loadTools()
    return () => {
      isMounted = false
    }
  }, [isAdmin])

  const { anyaCopilotEnabled: copilotEnabled, anyaScreenshotEnabled: screenshotEnabled } = useFeatureFlags()
  const anyaContext = useAnyaContext()
  const navigate = useNavigate()
  const onboardingActions = useMemo(() => [
    { type: "navigate", label: "Create or select a profile", payload: { path: createPageUrl("MyProfiles") } },
    { type: "navigate", label: "Run Discover Grants", payload: { path: createPageUrl("DiscoverGrants") } },
    { type: "navigate", label: "Add a grant to Pipeline", payload: { path: createPageUrl("Pipeline") } },
  ], [])
  const nextStepActions = useMemo(() => {
    if (!copilotEnabled) return []
    const fromAdapter = anyaContext?.adapter?.suggestedActions
    if (fromAdapter && fromAdapter.length > 0) return fromAdapter.slice(0, 5)
    return onboardingActions
  }, [copilotEnabled, anyaContext?.adapter?.suggestedActions, onboardingActions])
  const runNextStepAction = useCallback(async (action) => {
    if (!action?.type) return
    try {
      if (action.type === "navigate" && action.payload?.path) {
        navigate(action.payload.path)
        toast({ title: "Opened", description: action.label })
        return
      }
      if (action.type === "invokeTool" && action.payload?.toolName && sessionId) {
        const params = { ...(action.payload.parameters || {}), profile_id: effectiveProfileId }
        await invokeAnyaTool(action.payload.toolName, params, { sessionId })
        toast({ title: "Done", description: action.label })
        await refreshMessages(sessionId)
        return
      }
      if (action.type === "openModal" && action.payload) {
        toast({ title: "Action", description: action.label })
        return
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Action failed",
        description: err instanceof Error ? err.message : "Please try again.",
      })
    }
  }, [navigate, sessionId, effectiveProfileId, refreshMessages])
  const [isSendingContext, setIsSendingContext] = useState(false)
  const handleUseCurrentScreen = useCallback(async () => {
    if (!sessionId) return
    setIsSendingContext(true)
    try {
      const ctx = serializeAnyaContext(anyaContext)
      const text = "Here's my current screen context: " + JSON.stringify(ctx)
      await postAnyaMessage(sessionId, text)
      toast({ title: "Context sent", description: "Anya can use this to tailor answers." })
      await refreshMessages(sessionId)
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to send context",
        description: err instanceof Error ? err.message : "Please try again.",
      })
    } finally {
      setIsSendingContext(false)
    }
  }, [sessionId, anyaContext, refreshMessages])

  const [isClearingConversation, setIsClearingConversation] = useState(false)

  /** Clear messages locally (keeps the same session) */
  const handleClearConversation = useCallback(async () => {
    setIsClearingConversation(true)
    try {
      setMessages([])
      setTasks([])
      toast({ title: "Conversation cleared", description: "Messages removed from view." })
    } finally {
      setIsClearingConversation(false)
    }
  }, [])

  /** Delete current session and start a brand-new one */
  const handleStartNewConversation = useCallback(async () => {
    setIsClearingConversation(true)
    try {
      if (sessionId) {
        try {
          await deleteAnyaSession(sessionId)
        } catch (_e) { log.debug('[AnyaChat] deleteAnyaSession error (non-critical)', _e) }
      }
      setMessages([])
      setTasks([])
      setSessionId(null)
      const newSession = await createAnyaSession({ profileId: effectiveProfileId ?? undefined })
      setSessionId(newSession?.id ?? null)
      toast({ title: "New conversation started" })
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to start new conversation",
        description: err instanceof Error ? err.message : "Please try again.",
      })
    } finally {
      setIsClearingConversation(false)
    }
  }, [sessionId, effectiveProfileId, log])

  if (isUnavailable) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-sm text-slate-700 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full overflow-hidden bg-gradient-to-br from-purple-600 to-blue-600">
            <img src="/images/anya-avatar.svg" alt="Anya" className="h-full w-full object-cover" />
          </div>
          <div className="font-semibold text-slate-800">Anya is temporarily unavailable</div>
        </div>
        <div className="mt-2 text-xs text-slate-600">
          The core app is still working; we’re restoring Anya’s services in the background. Refresh in a minute.
        </div>
      </div>
    )
  }

  // Enable input/button as soon as we have a sessionId, even if messages are still loading
  const isDisabled = !sessionId

  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || isDisabled) {
      log.debug('handleSend returning early', { hasText: Boolean(trimmed), isDisabled })
      return
    }
    // Synchronous ref guard prevents rapid double-sends before React re-renders the disabled state
    if (isSendingRef.current) return
    isSendingRef.current = true
    setIsSending(true)
    log.debug('sending message', { sessionId })
    let optimisticId = null
    try {
      optimisticId = uuid()
      const optimisticMessage = {
        id: optimisticId,
        session_id: sessionId,
        created_at: new Date().toISOString(),
        role: "user",
        content: trimmed,
      }
      setMessages((prev) => [...prev, optimisticMessage])
      setInput("")

      const response = await postAnyaMessage(sessionId, trimmed)
      if (Array.isArray(response?.messages) && response.messages.length > 0) {
        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== optimisticId)
          return [...withoutOptimistic, ...response.messages]
        })
      } else {
        await refreshMessages(sessionId)
      }
      log.debug('messages refreshed')
    } catch (error) {
      console.error("[AnyaChat] send failed:", error)
      if (optimisticId) {
        setMessages((prev) => prev.filter((message) => message.id !== optimisticId))
      }
      setInput(trimmed)
      toast({
        variant: "destructive",
        title: "Failed to send message",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      isSendingRef.current = false
      setIsSending(false)
    }
  }

  const handleCodeSearchSubmit = async (event) => {
    event.preventDefault()
    if (!sessionId) return
    const query = codeSearchForm.query.trim()
    if (!query) {
      toast({
        variant: "destructive",
        title: "Enter a search query",
        description: "Provide text to search for before running the tool.",
      })
      return
    }

    setIsInvokingTool(true)
    try {
      const response = await invokeAnyaTool(
        "code.search",
        {
          query,
          scope: codeSearchForm.scope.trim() || undefined,
          max_results: 25,
        },
        { sessionId },
      )
      const matchCount = response?.result?.output?.matches?.length ?? 0
      toast({
        title: "Code search complete",
        description: `${matchCount} match${matchCount === 1 ? "" : "es"} found.`,
      })
      await refreshMessages(sessionId)
      setCodeSearchForm({ query: "", scope: "" })
      setIsCodeSearchOpen(false)
    } catch (error) {
      console.error("[AnyaChat] code search failed", error)
      toast({
        variant: "destructive",
        title: "Code search failed",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setIsInvokingTool(false)
    }
  }

  const handleTaskSubmit = async (event) => {
    event.preventDefault()
    if (!sessionId) return
    const title = taskForm.title.trim()
    if (!title) {
      toast({
        variant: "destructive",
        title: "Task title required",
        description: "Add a short description for the task before saving.",
      })
      return
    }

    setIsSavingTask(true)
    try {
      const payload = { title }
      if (taskForm.dueDate) {
        payload.due_date = taskForm.dueDate
      }
      await createAnyaTask(sessionId, payload)
      toast({
        title: "Task logged",
        description: "Anya recorded the follow-up in this session.",
      })
      setTaskForm({ title: "", dueDate: "" })
      await refreshTasks(sessionId)
    } catch (error) {
      console.error("[AnyaChat] create task failed", error)
      toast({
        variant: "destructive",
        title: "Unable to create task",
        description: error instanceof Error ? error.message : "Please try again soon.",
      })
    } finally {
      setIsSavingTask(false)
    }
  }

  const handleTaskStatusChange = async (task, checked) => {
    if (!sessionId || !task?.id) return
    const nextStatus = checked ? "completed" : "open"
    setUpdatingTaskId(task.id)
    try {
      const response = await updateAnyaTask(sessionId, task.id, { status: nextStatus })
      const updatedTask = response?.task ?? {
        ...task,
        status: nextStatus,
        completed_at: checked ? new Date().toISOString() : null,
      }
      setTasks((prev) => prev.map((entry) => (entry.id === task.id ? updatedTask : entry)))
    } catch (error) {
      console.error("[AnyaChat] update task failed", error)
      toast({
        variant: "destructive",
        title: "Could not update task",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setUpdatingTaskId(null)
    }
  }

  const handleGrantInsights = async () => {
    if (!sessionId || !profileId) return
    setIsFetchingInsights(true)
    try {
      await invokeAnyaTool(
        "grants.summarizeMatches",
        {
          profile_id: profileId,
          limit: 5,
        },
        { sessionId },
      )
      toast({
        title: "Grant insights ready",
        description: "Anya summarised the latest matches in the chat thread.",
      })
      await refreshMessages(sessionId)
    } catch (error) {
      console.error("[AnyaChat] grant summary failed", error)
      toast({
        variant: "destructive",
        title: "Unable to fetch insights",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setIsFetchingInsights(false)
    }
  }

  const handleRunAdminTool = async (tool) => {
    if (!sessionId || !tool?.name) return
    setInvokingAdminTool(tool.name)
    try {
      await invokeAnyaTool(tool.name, { profile_id: effectiveProfileId }, { sessionId })
      toast({
        title: `${tool.name} completed`,
        description: "Results have been posted to the chat thread.",
      })
      await refreshMessages(sessionId)
    } catch (error) {
      console.error(`[AnyaChat] admin tool ${tool.name} failed`, error)
      toast({
        variant: "destructive",
        title: `${tool.name} failed`,
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setInvokingAdminTool(null)
    }
  }

  const isCodeSearchDisabled =
    !hasCodeSearchTool || !sessionId || isLoading || isInvokingTool || isLoadingTools
  const isGrantInsightsDisabled =
    !hasGrantTool || !sessionId || !profileId || isLoading || isFetchingInsights || isLoadingTools
  const isTaskFormDisabled = !sessionId || isLoading || isSavingTask

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white/80 shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3 max-h-[40%] overflow-y-auto shrink-0">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full overflow-hidden bg-gradient-to-br from-purple-600 to-blue-600">
                  <img 
                    src="/images/anya-avatar.svg" 
                    alt="Anya" 
                    className="h-full w-full object-cover"
                  />
                </div>
                <h2 className="text-sm font-semibold text-slate-800">Anya, your GrantFlow copilot</h2>
                {isAdmin && (
                  <Badge variant="default" className="gap-1 text-[11px] bg-purple-600">
                    <Shield className="h-3 w-3" />
                    ADMIN
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-slate-500 hover:text-red-600 hover:bg-red-50"
                    onClick={handleClearConversation}
                    disabled={isClearingConversation || messages.length === 0}
                    title="Clear conversation (keeps same session)"
                  >
                    {isClearingConversation ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-slate-500 hover:text-purple-600 hover:bg-purple-50"
                    onClick={handleStartNewConversation}
                    disabled={isClearingConversation}
                    title="Start new conversation"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-600">
                Ask about grant matches, automation jobs, or request code assistance. All actions stay
                within this profile.
              </p>
            </div>
            {copilotEnabled ? (
              <>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Next steps</h3>
                  <div className="flex flex-wrap gap-2">
                    {nextStepActions.map((action, idx) => (
                      <Button
                        key={idx}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs h-8"
                        onClick={() => runNextStepAction(action)}
                      >
                        {action.label?.includes("Pipeline") || action.label?.includes("pipeline") ? (
                          <Kanban className="h-3.5 w-3.5 shrink-0" />
                        ) : action.label?.includes("Discover") || action.label?.includes("discover") ? (
                          <Compass className="h-3.5 w-3.5 shrink-0" />
                        ) : action.label?.includes("Document") || action.label?.includes("document") ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        ) : action.label?.includes("profile") ? (
                          <User className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate max-w-[140px]">{action.label}</span>
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-xs text-slate-600"
                    onClick={handleUseCurrentScreen}
                    disabled={!sessionId || isSendingContext}
                    title="Send current page context to Anya"
                  >
                    {isSendingContext ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Monitor className="h-3.5 w-3.5" />
                    )}
                    Use current screen
                  </Button>
                </div>
              </>
            ) : null}
            {(hasQuickActions || hasAdminTools || isLoadingTools) ? (
              <div className="flex items-center gap-2 flex-wrap">
                {hasGrantTool ? (
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={handleGrantInsights}
                    disabled={isGrantInsightsDisabled}
                  >
                    {isFetchingInsights ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    Grant insights
                  </Button>
                ) : null}
                {hasCodeSearchTool ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={isCodeSearchDisabled}
                    onClick={() => setIsCodeSearchOpen(true)}
                  >
                    {isInvokingTool ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Code search
                  </Button>
                ) : null}
                {hasAdminTools ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-purple-300 bg-purple-50 hover:bg-purple-100"
                    onClick={() => setIsAdminToolsOpen(true)}
                    disabled={!sessionId || isLoading}
                  >
                    <Wrench className="h-4 w-4" />
                    Admin Tools
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          {!hasQuickActions && !isLoadingTools ? (
            <p className="text-xs text-slate-600">
              Tool registry still loading. Quick actions will appear here shortly.
            </p>
          ) : null}
          {sessionId ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  className="flex items-center gap-2 text-left"
                  onClick={() => setIsTasksExpanded((prev) => !prev)}
                >
                  {isTasksExpanded ? (
                    <ChevronDown className="h-3 w-3 text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-slate-500 shrink-0" />
                  )}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Session tasks
                    </h3>
                    <p className="text-xs text-slate-600">
                      {isTasksExpanded ? "Capture action items so nothing falls through." : "Click to expand"}
                    </p>
                  </div>
                </button>
                <Badge variant={openTaskCount > 0 ? "secondary" : "outline"} className="text-[11px]">
                  {openTaskCount} open
                </Badge>
              </div>
              {isTasksExpanded && (
                <>
                  <div className="mt-3 space-y-2">
                {isLoadingTasks ? (
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                    Fetching tasks…
                  </div>
                ) : hasTasks ? (
                  sortedTasks.map((task) => {
                    const isCompleted = task.status === "completed"
                    const taskIsUpdating = updatingTaskId === task.id
                    let dueLabel = null
                    if (task.due_date) {
                      const dueDate = new Date(`${task.due_date}T00:00:00`)
                      if (!Number.isNaN(dueDate.getTime())) {
                        dueLabel = `Due ${formatDistanceToNow(dueDate, { addSuffix: true })}`
                      } else {
                        dueLabel = `Due ${task.due_date}`
                      }
                    }
                    return (
                      <div
                        key={task.id}
                        className="flex items-start gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
                      >
                        <Checkbox
                          id={`anya-task-${task.id}`}
                          checked={isCompleted}
                          onCheckedChange={(checked) =>
                            handleTaskStatusChange(task, checked === true)
                          }
                          disabled={taskIsUpdating || !sessionId}
                          className="mt-1"
                        />
                        <div className="flex flex-1 flex-col gap-1">
                          <span
                            className={cn(
                              "text-sm font-medium text-slate-700",
                              isCompleted && "line-through text-slate-400",
                            )}
                          >
                            {task.title}
                          </span>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                            {dueLabel ? <span>{dueLabel}</span> : null}
                            {task.priority && task.priority !== "normal" ? (
                              <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 font-medium uppercase tracking-wide text-[11px] text-slate-600">
                                {task.priority}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <p className="text-xs text-slate-600">
                    No tasks yet. Log a follow-up below to keep momentum.
                  </p>
                )}
                  </div>
                  <form onSubmit={handleTaskSubmit} className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                  <div className="space-y-1">
                    <Label htmlFor="anya-task-title" className="text-xs text-slate-600">
                      Task title
                    </Label>
                    <Input
                      id="anya-task-title"
                      value={taskForm.title}
                      onChange={(event) =>
                        setTaskForm((prev) => ({ ...prev, title: event.target.value }))
                      }
                      placeholder="e.g. Draft budget narrative"
                      disabled={isTaskFormDisabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="anya-task-due" className="text-xs text-slate-600">
                      Due date (optional)
                    </Label>
                    <Input
                      id="anya-task-due"
                      type="date"
                      value={taskForm.dueDate}
                      onChange={(event) =>
                        setTaskForm((prev) => ({ ...prev, dueDate: event.target.value }))
                      }
                      disabled={isTaskFormDisabled}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end">
                  <Button type="submit" size="sm" className="gap-2" disabled={isTaskFormDisabled}>
                    {isSavingTask ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Add task
                  </Button>
                </div>
              </form>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-[200px] px-4 py-4">
        {!isLoading && !hasMessages ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-500">
            <p>Anya is ready. Start by asking about a grant or automation job.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isSending ? (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                Working…
              </div>
            ) : null}
          </div>
        )}
      </ScrollArea>

      <form
        className="border-t border-slate-200 bg-slate-50/80 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          handleSend()
        }}
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleSend()
            }
          }}
          placeholder="Ask Anya for help…"
          rows={3}
          className="resize-none text-sm bg-white border-slate-200 text-slate-900 placeholder:text-slate-500 focus-visible:ring-slate-400"
          disabled={isDisabled}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-slate-600">
            Anya keeps all actions scoped to this profile.
          </span>
          <Button
            type="submit"
            disabled={isDisabled || isSending || !input.trim()}
            size="sm"
            className="gap-2"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </div>
      </form>

      <Dialog
        open={isCodeSearchOpen}
        onOpenChange={(open) => {
          setIsCodeSearchOpen(open)
          if (!open) {
            setCodeSearchForm({ query: "", scope: "" })
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Code search</DialogTitle>
            <DialogDescription>
              Search the repository for a case-insensitive match across allowed directories. Provide an
              optional scope to narrow results.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCodeSearchSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="anya-code-search-query">Search query</Label>
              <Input
                id="anya-code-search-query"
                value={codeSearchForm.query}
                onChange={(event) =>
                  setCodeSearchForm((prev) => ({ ...prev, query: event.target.value }))
                }
                placeholder="e.g. retry_count"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="anya-code-search-scope">Scope (optional)</Label>
              <Input
                id="anya-code-search-scope"
                value={codeSearchForm.scope}
                onChange={(event) =>
                  setCodeSearchForm((prev) => ({ ...prev, scope: event.target.value }))
                }
                placeholder="backend/routes"
              />
              <p className="text-xs text-slate-600">
                Path should be relative to the repository root and within backend/, src/, or scripts/.
              </p>
            </div>
            <DialogFooter className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsCodeSearchOpen(false)
                  setCodeSearchForm({ query: "", scope: "" })
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isInvokingTool || !codeSearchForm.query.trim()}>
                {isInvokingTool ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Run search
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isAdminToolsOpen} onOpenChange={setIsAdminToolsOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-purple-600" />
              Admin Tools
            </DialogTitle>
            <DialogDescription>
              Advanced diagnostic and management tools for administrators. Use with caution.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {adminTools.diagnostics && adminTools.diagnostics.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-purple-700" />
                  <h3 className="font-semibold text-sm text-slate-900">System Diagnostics</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.diagnostics.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5 border-purple-300 text-purple-700 hover:bg-purple-50"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Activity className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.health && adminTools.health.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Health & Monitoring</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.health.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.crawler && adminTools.crawler.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Crawler Management</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.crawler.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.autonomous && adminTools.autonomous.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Autonomous Operations</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.autonomous.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.code && adminTools.code.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Code className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Code Analysis</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.code.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.database && adminTools.database.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Database & Queries</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.database.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.functions && adminTools.functions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Function Testing</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.functions.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.brain && adminTools.brain.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Brain Management</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.brain.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.other && adminTools.other.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Other Tools</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.other.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={!sessionId || invokingAdminTool === tool.name}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <p className="text-xs text-slate-600 text-left flex-1">
              You can also ask Anya to use any tool by referencing its name in your message.
            </p>
            <Button variant="outline" onClick={() => setIsAdminToolsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
