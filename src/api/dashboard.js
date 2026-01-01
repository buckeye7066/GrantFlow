import { apiFetch } from "@/api/client"

export async function getPipelineStats() {
  return apiFetch("/api/pipeline/stats")
}

export async function getDashboardStats() {
  return apiFetch("/api/stats")
}

export async function getReminders() {
  return apiFetch("/api/reminders")
}

export async function generateReminderPlan(data) {
  return apiFetch("/api/ai/reminders/plan", {
    method: "POST",
    body: JSON.stringify(data ?? {}),
  })
}
