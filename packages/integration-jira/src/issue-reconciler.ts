import { workItemPhaseSemantics } from '@factory/core';
import type { Intake, IntakeIssue } from '@factory/capabilities';
import type { IntegrationContext } from '@factory/integrations';
import { createIssueReconciler } from '@factory/integrations';
import type { IssueReconciler } from '@factory/integrations';
import type { JiraEventRules } from './default-rules.ts';
import { JiraRules } from './rules.ts';
import type { JiraIssueIngress } from './rules.ts';

export type JiraIssueReconciler = IssueReconciler;

function issueToIngress(issueRef: string, issue: IntakeIssue): JiraIssueIngress {
  return {
    id: issueRef,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state ?? '',
    stateType: issue.stateType ?? '',
    priorityLabel: issue.priority ?? '',
    assignee: issue.assignee ?? null,
    author: issue.author ?? null,
    project: issue.source ?? null,
    site: null,
    labels: [...(issue.labels ?? [])],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

export function attachJiraIssueReconciler(
  jira: { intake: Intake; rules: JiraEventRules },
  context: IntegrationContext,
): JiraIssueReconciler | undefined {
  if (!context.runtime || !jira.intake.resolveIntakeDispatch) return undefined;
  const boards = context.runtime.boards;

  const rules = new JiraRules({
    projects: context.storage.projects,
    storage: context.runtime.workItems,
    configVersion: context.runtime.configVersion,
    boards,
    jiraRules: jira.rules,
  });

  return createIssueReconciler({
    integrationId: 'jira',
    intake: jira.intake,
    projects: context.storage.projects,
    storage: context.runtime.workItems,
    isTerminal: item => workItemPhaseSemantics(boards, item)?.kind === 'terminal',
    issueId: item => item.externalSource?.externalId,
    metadata: (item, issue) => ({
      identifier: issue.identifier,
      issueRef: item.externalSource?.externalId ?? issue.id,
      autoStartCandidate: issue.stateType === 'unstarted' || issue.stateType === 'started',
      state: issue.state,
      stateType: issue.stateType,
      priority: issue.priority,
      project: issue.source,
      assignee: issue.assignee,
      assignees: issue.assignees ?? [],
      creator: issue.author,
      author: issue.author,
      labels: issue.labels ?? [],
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    }),
    onClosed: async (item, issue, project) => {
      await rules.ingest({
        orgId: project.orgId,
        userId: 'factory-rule-dispatcher',
        factoryProjectId: project.id,
        issues: [issueToIngress(item.externalSource?.externalId ?? issue.id, issue)],
      });
    },
  });
}
