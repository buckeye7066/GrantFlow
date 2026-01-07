import React, { useCallback, useEffect, useMemo, useState } from "react"
import { v4 as uuid } from "uuid"
import { Loader2, Search, Send, Sparkles, Plus, Shield, Database, Activity, Code, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
import { toast } from "@/components/ui/use-toast"
import { useAuthStore } from "@/stores/authStore"
import {
  getAnyaSessions,
  createAnyaSession,
  getAnyaMessages,
  postAnyaMessage,
  listAnyaTools,
  invokeAnyaTool,
  getAnyaTasks,
  createAnyaTask,
  updateAnyaTask,
} from "@/lib/anyaClient"
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

function MessageBubble({ message }) {
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
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500 pb-1">
        <Badge variant={isAssistant ? "secondary" : "outline"} className="text-[10px] uppercase tracking-wide">
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
        <div className="mt-2 space-y-2 text-[11px] text-slate-500">
          <div>
            Tool: <span className="font-mono text-[11px] text-slate-600">{message.tool_name}</span>
          </div>
          {message.tool_payload ? (
            <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white/80 p-2 text-xs text-slate-700">
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(message.tool_payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default function AnyaChat({ profileId }) {
  const user = useAuthStore((state) => state.user)
  const isAdmin = Boolean(user?.is_admin)
  const effectiveProfileId = profileId ?? null
  
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
  const [updatingTaskId, setUpdatingTaskId] = useState(null)
  const [isAdminToolsOpen, setIsAdminToolsOpen] = useState(false)
  const [adminToolForm, setAdminToolForm] = useState({})

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
  
  // Group admin tools by category
  const adminTools = useMemo(() => {
    if (!isAdmin) return {}
    
    const adminToolsList = tools.filter((tool) => tool.requiresAdmin)
    const grouped = {
      code: adminToolsList.filter((t) => t.name.startsWith("admin.code.")),
      crawler: adminToolsList.filter((t) => t.name.startsWith("admin.crawler.")),
      functions: adminToolsList.filter((t) => t.name.startsWith("admin.functions.")),
      database: adminToolsList.filter((t) => t.name.startsWith("admin.db.")),
      health: adminToolsList.filter((t) => t.name.startsWith("admin.health.")),
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
        const existing = sessions?.find((session) => {
          if (effectiveProfileId) {
            return session.profile_id === effectiveProfileId
          }
          return !session.profile_id
        })
        let activeSession = existing
        if (!activeSession) {
          activeSession = await createAnyaSession({ profileId: effectiveProfileId ?? undefined })
        }
        if (!isMounted) return
        setSessionId(activeSession?.id ?? null)
        if (activeSession?.id) {
          await refreshMessages(activeSession.id)
          await refreshTasks(activeSession.id, { withLoading: true })
        }
      } catch (error) {
        console.error("[AnyaChat] bootstrap failed", error)
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

  const isDisabled = !sessionId || isLoading

  async function handleSend() {
    const trimmed = input.trim()
    console.log('[AnyaChat] handleSend called', { trimmed, isDisabled, sessionId, isLoading, input })
    if (!trimmed || isDisabled) {
      console.warn('[AnyaChat] handleSend returning early', { trimmed: !!trimmed, isDisabled })
      return
    }
    setIsSending(true)
    console.log('[AnyaChat] Sending message to session', sessionId)
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

      console.log('[AnyaChat] Calling postAnyaMessage...')
      await postAnyaMessage(sessionId, trimmed)
      console.log('[AnyaChat] postAnyaMessage completed, refreshing messages...')
      await refreshMessages(sessionId)
      console.log('[AnyaChat] Messages refreshed successfully')
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

  const isCodeSearchDisabled =
    !hasCodeSearchTool || !sessionId || isLoading || isInvokingTool || isLoadingTools
  const isGrantInsightsDisabled =
    !hasGrantTool || !sessionId || isLoading || isFetchingInsights || isLoadingTools
  const isTaskFormDisabled = !sessionId || isLoading || isSavingTask

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white/80 shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
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
                  <Badge variant="default" className="gap-1 text-[10px] bg-purple-600">
                    <Shield className="h-3 w-3" />
                    ADMIN
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-500">
                Ask about grant matches, automation jobs, or request code assistance. All actions stay
                within this profile.
              </p>
            </div>
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
            <p className="text-[11px] text-slate-400">
              Tool registry still loading. Quick actions will appear here shortly.
            </p>
          ) : null}
          {sessionId ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Session tasks
                  </h3>
                  <p className="text-xs text-slate-500">
                    Capture action items so nothing falls through.
                  </p>
                </div>
                <Badge variant={openTaskCount > 0 ? "secondary" : "outline"} className="text-[10px]">
                  {openTaskCount} open
                </Badge>
              </div>
              <div className="mt-3 space-y-2">
                {isLoadingTasks ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
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
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                            {dueLabel ? <span>{dueLabel}</span> : null}
                            {task.priority && task.priority !== "normal" ? (
                              <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 font-medium uppercase tracking-wide text-[10px] text-slate-600">
                                {task.priority}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <p className="text-xs text-slate-500">
                    No tasks yet. Log a follow-up below to keep momentum.
                  </p>
                )}
              </div>
              <form onSubmit={handleTaskSubmit} className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                  <div className="space-y-1">
                    <Label htmlFor="anya-task-title" className="text-[11px] text-slate-500">
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
                    <Label htmlFor="anya-task-due" className="text-[11px] text-slate-500">
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
            </div>
          ) : null}
        </div>
      </div>

      <ScrollArea className="flex-1 px-4 py-4">
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
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                Working…
              </div>
            ) : null}
          </div>
        )}
      </ScrollArea>

      <div className="border-t border-slate-200 bg-slate-50/80 px-4 py-3">
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
          className="resize-none text-sm"
          disabled={isDisabled}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            Anya keeps all actions scoped to this profile.
          </span>
          <Button
            onClick={handleSend}
            disabled={isDisabled || isSending || !input.trim()}
            size="sm"
            className="gap-2"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </div>
      </div>

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
              <p className="text-[11px] text-slate-400">
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
            {adminTools.code && adminTools.code.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Code className="h-4 w-4 text-slate-600" />
                  <h3 className="font-semibold text-sm">Code Analysis</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.code.map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="font-mono text-xs text-purple-600">{tool.name}</div>
                      <div className="text-xs text-slate-600 mt-1">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.crawler && adminTools.crawler.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-slate-600" />
                  <h3 className="font-semibold text-sm">Crawler Management</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.crawler.map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="font-mono text-xs text-purple-600">{tool.name}</div>
                      <div className="text-xs text-slate-600 mt-1">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.database && adminTools.database.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-slate-600" />
                  <h3 className="font-semibold text-sm">Database & Diagnostics</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.database.map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="font-mono text-xs text-purple-600">{tool.name}</div>
                      <div className="text-xs text-slate-600 mt-1">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.health && adminTools.health.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-slate-600" />
                  <h3 className="font-semibold text-sm">Health & Monitoring</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.health.map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="font-mono text-xs text-purple-600">{tool.name}</div>
                      <div className="text-xs text-slate-600 mt-1">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.functions && adminTools.functions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-slate-600" />
                  <h3 className="font-semibold text-sm">Function Testing</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.functions.map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="font-mono text-xs text-purple-600">{tool.name}</div>
                      <div className="text-xs text-slate-600 mt-1">{tool.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <p className="text-xs text-slate-500 text-left flex-1">
              Ask Anya to use any of these tools by referencing their name in your message.
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
