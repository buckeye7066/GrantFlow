import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export function useOrganizations() {
  return useQuery({ queryKey: ['organizations'], queryFn: function ({ signal }) { return api.get('/organizations', { signal: signal }); } });
}

export function useOpportunities(filters) {
  return useQuery({
    queryKey: ['opportunities', filters],
    queryFn: function ({ signal }) { return api.get('/opportunities', { query: filters, signal: signal }); },
    placeholderData: function (prev) { return prev; },
  });
}

export function useOpportunity(id) {
  return useQuery({
    queryKey: ['opportunity', id],
    queryFn: function ({ signal }) { return api.get('/opportunities/' + encodeURIComponent(id), { signal: signal }); },
    enabled: !!id,
  });
}

export function useOpportunitySources(id) {
  return useQuery({
    queryKey: ['opportunity', id, 'sources'],
    queryFn: function ({ signal }) { return api.get('/opportunities/' + encodeURIComponent(id) + '/sources', { signal: signal }); },
    enabled: !!id,
  });
}

export function useOpportunityVersions(id) {
  return useQuery({
    queryKey: ['opportunity', id, 'versions'],
    queryFn: function ({ signal }) { return api.get('/opportunities/' + encodeURIComponent(id) + '/versions', { signal: signal }); },
    enabled: !!id,
  });
}

export function useRelatedOpportunities(id) {
  return useQuery({
    queryKey: ['opportunity', id, 'related'],
    queryFn: function ({ signal }) { return api.get('/opportunities/' + encodeURIComponent(id) + '/related', { signal: signal }); },
    enabled: !!id,
  });
}

export function useAlerts() {
  return useQuery({
    queryKey: ['alerts'],
    queryFn: function ({ signal }) { return api.get('/alerts', { query: { limit: 25 }, signal: signal }); },
  });
}

export function useProfiles() {
  return useQuery({ queryKey: ['profiles'], queryFn: function ({ signal }) { return api.get('/profiles', { signal: signal }); } });
}

export function useRecommendations(profileId) {
  return useQuery({
    queryKey: ['recommendations', profileId],
    queryFn: function ({ signal }) { return api.get('/recommendations', { query: { applicantProfileId: profileId }, signal: signal }); },
    enabled: !!profileId,
  });
}

export function useConnectors() {
  return useQuery({ queryKey: ['connectors'], queryFn: function ({ signal }) { return api.get('/connectors', { signal: signal }); } });
}

export function useConnectorRuns(id) {
  return useQuery({
    queryKey: ['connector', id, 'runs'],
    queryFn: function ({ signal }) { return api.get('/connectors/' + encodeURIComponent(id) + '/runs', { query: { limit: 20 }, signal: signal }); },
    enabled: !!id,
  });
}

export function useFunders(filters) {
  return useQuery({
    queryKey: ['funders', filters],
    queryFn: function ({ signal }) { return api.get('/funders', { query: filters, signal: signal }); },
  });
}

export function useFunder(id) {
  return useQuery({
    queryKey: ['funder', id],
    queryFn: function ({ signal }) { return api.get('/funders/' + encodeURIComponent(id), { signal: signal }); },
    enabled: !!id,
  });
}

export function useFunderAwards(id) {
  return useQuery({
    queryKey: ['funder', id, 'awards'],
    queryFn: function ({ signal }) { return api.get('/funders/' + encodeURIComponent(id) + '/awards', { signal: signal }); },
    enabled: !!id,
  });
}

export function useFunderInsights(id) {
  return useQuery({
    queryKey: ['funder', id, 'insights'],
    queryFn: function ({ signal }) { return api.get('/funders/' + encodeURIComponent(id) + '/insights', { signal: signal }); },
    enabled: !!id,
  });
}

export function useKnowledge(filters) {
  return useQuery({
    queryKey: ['knowledge', filters],
    queryFn: function ({ signal }) { return api.get('/knowledge', { query: filters, signal: signal }); },
  });
}

export function useProposal(id) {
  return useQuery({
    queryKey: ['proposal', id],
    queryFn: function ({ signal }) { return api.get('/proposals/' + encodeURIComponent(id), { signal: signal }); },
    enabled: !!id,
  });
}

export function useRequirements(proposalId) {
  return useQuery({
    queryKey: ['proposal', proposalId, 'requirements'],
    queryFn: function ({ signal }) { return api.get('/proposals/' + encodeURIComponent(proposalId) + '/requirements', { signal: signal }); },
    enabled: !!proposalId,
  });
}

export function useSections(proposalId) {
  return useQuery({
    queryKey: ['proposal', proposalId, 'sections'],
    queryFn: function ({ signal }) { return api.get('/proposals/' + encodeURIComponent(proposalId) + '/sections', { signal: signal }); },
    enabled: !!proposalId,
  });
}

export function usePipeline(filters) {
  return useQuery({
    queryKey: ['pipeline', filters],
    queryFn: function ({ signal }) { return api.get('/pipeline', { query: filters, signal: signal }); },
  });
}

export function usePipelineActivity(itemId) {
  return useQuery({
    queryKey: ['pipeline', itemId, 'activity'],
    queryFn: function ({ signal }) { return api.get('/pipeline/' + encodeURIComponent(itemId) + '/activity', { signal: signal }); },
    enabled: !!itemId,
  });
}

export function useAwards(filters) {
  return useQuery({
    queryKey: ['awards', filters],
    queryFn: function ({ signal }) { return api.get('/awards', { query: filters, signal: signal }); },
  });
}

export function useAward(id) {
  return useQuery({
    queryKey: ['award', id],
    queryFn: function ({ signal }) { return api.get('/awards/' + encodeURIComponent(id), { signal: signal }); },
    enabled: !!id,
  });
}

export function useCalendar(filters) {
  return useQuery({
    queryKey: ['calendar', filters],
    queryFn: function ({ signal }) { return api.get('/calendar', { query: filters, signal: signal }); },
  });
}

export function useAdminUsers() {
  return useQuery({ queryKey: ['admin', 'users'], queryFn: function ({ signal }) { return api.get('/admin/users', { signal: signal }); } });
}

export function useAdminAudit(filters) {
  return useQuery({
    queryKey: ['admin', 'audit', filters],
    queryFn: function ({ signal }) { return api.get('/admin/audit', { query: filters, signal: signal }); },
  });
}

export function useOpsSummary() {
  return useQuery({ queryKey: ['admin', 'ops', 'summary'], queryFn: function ({ signal }) { return api.get('/admin/ops/summary', { signal: signal }); } });
}

export function useDashboardSummary() {
  return useQuery({ queryKey: ['dashboard', 'summary'], queryFn: function ({ signal }) { return api.get('/dashboard/summary', { signal: signal }); } });
}

export function useSaveSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (body) { return api.post('/saved-searches', body); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['saved-searches'] }); },
  });
}

export function useFollowFunder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (body) { return api.post('/funder-follows', body); },
    onSuccess: function (_d, vars) { qc.invalidateQueries({ queryKey: ['funder', vars.funderId] }); qc.invalidateQueries({ queryKey: ['funders'] }); },
  });
}

export function useUpdatePipelineStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.patch('/pipeline/' + encodeURIComponent(args.id), { stage: args.stage }); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['pipeline'] }); },
  });
}

export function useCreateSubmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.post('/pipeline/' + encodeURIComponent(args.pipelineItemId) + '/submission', args.body); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['pipeline'] }); },
  });
}

export function useSetKnowledgeApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.patch('/knowledge/' + encodeURIComponent(args.id), { approvedForAiUse: args.approvedForAiUse }); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['knowledge'] }); },
  });
}

export function useSaveKnowledgeItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (body) { return body.id ? api.patch('/knowledge/' + encodeURIComponent(body.id), body) : api.post('/knowledge', body); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['knowledge'] }); },
  });
}

export function useGenerateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.post('/proposals/' + encodeURIComponent(args.workspaceId) + '/sections/' + encodeURIComponent(args.sectionId) + '/draft', {}); },
    onSuccess: function (_d, vars) { qc.invalidateQueries({ queryKey: ['proposal', vars.workspaceId, 'sections'] }); },
  });
}

export function useSaveSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.patch('/proposals/' + encodeURIComponent(args.workspaceId) + '/sections/' + encodeURIComponent(args.sectionId), args.body); },
    onSuccess: function (_d, vars) { qc.invalidateQueries({ queryKey: ['proposal', vars.workspaceId, 'sections'] }); },
  });
}

export function useGeneratePacket() {
  return useMutation({
    mutationFn: function (workspaceId) { return api.post('/proposals/' + encodeURIComponent(workspaceId) + '/packet', {}); },
  });
}

export function useConnectorDryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (id) { return api.post('/connectors/' + encodeURIComponent(id) + '/dry-run', {}); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['connectors'] }); },
  });
}

export function useConnectorSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (id) { return api.post('/connectors/' + encodeURIComponent(id) + '/sync', {}); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['connectors'] }); },
  });
}

export function useReplayRawRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.post('/connectors/' + encodeURIComponent(args.connectorId) + '/replay', { rawRecordId: args.rawRecordId }); },
    onSuccess: function (_d, vars) { qc.invalidateQueries({ queryKey: ['connector', vars.connectorId, 'runs'] }); },
  });
}

export function useToggleConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.patch('/connectors/' + encodeURIComponent(args.id), { enabled: args.enabled }); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['connectors'] }); },
  });
}

export function useAdminExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (body) { return api.post('/admin/exports', body); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['admin', 'audit'] }); },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (userId) { return api.delete('/admin/users/' + encodeURIComponent(userId)); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); },
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (args) { return api.patch('/admin/users/' + encodeURIComponent(args.userId), { role: args.role }); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); },
  });
}

export function useSwitchOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (organizationId) { return api.post('/session/organization', { organizationId: organizationId }); },
    onSuccess: function () { qc.invalidateQueries(); },
  });
}

export function useDismissAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: function (id) { return api.post('/alerts/' + encodeURIComponent(id) + '/read', {}); },
    onSuccess: function () { qc.invalidateQueries({ queryKey: ['alerts'] }); },
  });
}
