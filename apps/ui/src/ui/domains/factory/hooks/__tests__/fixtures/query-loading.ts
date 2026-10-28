import type { IntakeConfig } from '../../../services/intake';
import type { GitLabStatus } from '../../../services/gitlab';

export const gitlabOnlyConfig: IntakeConfig = {
  github: { enabled: false, sourceIds: null },
  gitlab: { enabled: true, sourceIds: ['gitlab-1'] },
  clickup: { enabled: false, sourceIds: null },
};
export const disabledGitlab: GitLabStatus = { enabled: false, configured: false, reauthRequired: false };
